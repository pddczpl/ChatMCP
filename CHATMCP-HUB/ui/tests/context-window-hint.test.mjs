import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';

// The note under the context window field of the AI settings says where the window the Hub plans with comes from: the one the owner typed, the one the model catalog gives for a model it is sure
// of (the Hub uses it without anything being written into the field), or none (then the Hub plans with a conservative estimate and says so on every task). These tests pin the rule.
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { contextWindowHint } from './src/lib/context-window';
  export { contextWindowHint };
`, 'chatmcp-window-hint-');
after(dispose);
const { contextWindowHint } = loaded;

const info = (extra = {}) => ({
  model: 'm', protocol: 'anthropic', preset: 'anthropic', found: true, confidence: 'exact', source: 'catalog@2026-10-19', provider: 'anthropic', local: false,
  contextWindow: 1000000, maxInput: null, maxOutput: 128000, trusted: true, capacity: 1000000, ...extra,
});

test('a window the owner set is the owner\'s, whatever the catalog says', () => {
  for (const shown of [131072, '131072', '64000', 'abc', '  5000 ']) assert.deepEqual(contextWindowHint(shown, info()), { kind: 'owner' }, String(shown));
  assert.deepEqual(contextWindowHint(131072, undefined), { kind: 'owner' }, 'before the Hub has answered too');
});

test('no window typed: the catalog\'s when the Hub is sure of the model, with the numbers written out', () => {
  assert.deepEqual(contextWindowHint('', info()), { kind: 'catalog', tokens: '1,000,000', source: 'catalog@2026-10-19' });
  for (const nothing of [null, undefined, '', '   ', '0', 0]) assert.equal(contextWindowHint(nothing, info()).kind, 'catalog', `${JSON.stringify(nothing)} is no window`);
  assert.deepEqual(contextWindowHint('', info({ contextWindow: 400000, maxInput: 272000, capacity: 288384, source: 'catalog@2026-11-02' })),
    { kind: 'catalog_limited', tokens: '288,384', window: '400,000', input: '272,000', source: 'catalog@2026-11-02' }, 'an input limit below the window: the Hub plans on the window the input limit leaves');
  assert.equal(contextWindowHint('', info({ contextWindow: 128000, maxInput: 128000, capacity: 128000 })).kind, 'catalog', 'an input limit equal to the window is not a limit');
  assert.deepEqual(contextWindowHint('', info({ contextWindow: 4000000, capacity: 2000000 })), { kind: 'catalog', tokens: '2,000,000', source: 'catalog@2026-10-19' }, 'the window the Hub plans on, which is the largest it takes, not the one the model has');
});

test('no window typed and nothing the Hub relies on: unknown', () => {
  assert.deepEqual(contextWindowHint('', undefined), { kind: 'unknown' }, 'the Hub has not answered');
  assert.deepEqual(contextWindowHint('', info({ found: false, confidence: 'none', trusted: false, capacity: null, contextWindow: null, source: null })), { kind: 'unknown' }, 'a model the catalog does not know');
  assert.deepEqual(contextWindowHint('', info({ confidence: 'alias', trusted: false, capacity: null })), { kind: 'unknown' }, 'an alias is shown elsewhere, but the Hub does not plan on it');
  assert.deepEqual(contextWindowHint('', info({ confidence: 'alias', trusted: false })), { kind: 'unknown' }, 'whatever numbers an alias comes with');
  assert.deepEqual(contextWindowHint('', info({ trusted: true, capacity: null })), { kind: 'unknown' }, 'trusted but with no window to plan on');
  assert.deepEqual(contextWindowHint('', info({ local: true, found: false, confidence: 'none', trusted: false, capacity: null })), { kind: 'unknown' }, 'a local runtime');
  assert.deepEqual(contextWindowHint('', info({ source: null })), { kind: 'catalog', tokens: '1,000,000', source: 'catalog' }, 'no label: the word catalog');
});
