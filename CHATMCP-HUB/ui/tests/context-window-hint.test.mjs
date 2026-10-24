import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';

// The note under the context window field of the AI settings says where the window the Hub plans with comes from: the one the owner typed, the one the model catalog gives for a model it is sure
// of (the Hub uses it without anything being written into the field), or none (then the Hub plans with a conservative estimate and says so on every task). These tests pin the rule.
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { contextWindowHint, windowHintSentence } from './src/lib/context-window';
  export { contextWindowHint, windowHintSentence };
`, 'chatmcp-window-hint-');
after(dispose);
const { contextWindowHint, windowHintSentence } = loaded;

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

// The model's price can rise with the length of the prompt (the Hub's catalog lists the point): the Hub plans up to it of its own accord, and the note says so, with the prices on either side.
const rise = (extra = {}) => ({ aboveTokens: 272000, tokens: 272000, floored: false, from: { input: 2.5, output: 15 }, to: { input: 5, output: 22.5 }, ...extra });

test('no window typed and the price of the model rises at a size: the Hub plans up to it, and the note has the reason', () => {
  const stopped = info({ contextWindow: 1050000, maxInput: 922000, capacity: 272000, modelCapacity: 938384, priceCap: rise() });
  assert.deepEqual(contextWindowHint('', stopped),
    { kind: 'catalog_price', tokens: '272,000', window: '1,050,000', above: '272,000', from: '$2.5 / $15', to: '$5 / $22.5', floored: false, source: 'catalog@2026-10-19' },
    'the price rise comes before the input limit: it is what stopped the plan');
  assert.deepEqual(contextWindowHint('', info({ capacity: 128000, priceCap: rise({ aboveTokens: 32000, tokens: 128000, floored: true, from: { input: 1, output: 5 }, to: { input: 2, output: 10 } }) })),
    { kind: 'catalog_price', tokens: '128,000', window: '1,000,000', above: '32,000', from: '$1 / $5', to: '$2 / $10', floored: true, source: 'catalog@2026-10-19' }, 'a rise below the floor: the floor is said');
  assert.equal(contextWindowHint('', info({ capacity: 200000, priceCap: rise({ aboveTokens: 200000, tokens: 200000, from: { input: 0.3, output: 2.5 }, to: { input: 0.60001, output: 1.23456789 } }) })).from, '$0.3 / $2.5', 'prices are written without the zeros that mean nothing');
  assert.equal(contextWindowHint('', info({ capacity: 200000, priceCap: rise({ aboveTokens: 200000, tokens: 200000, to: { input: 0.60001, output: 1.23456789 } }) })).to, '$0.6 / $1.2346', 'and with at most four decimals');
  assert.equal(contextWindowHint('', info({ contextWindow: null, capacity: 200000, priceCap: rise({ aboveTokens: 150000, tokens: 200000 }) })).window, '200,000', 'with no window of the model\'s to name, the plan is named');
  // the owner's number is the owner's, whatever stopped the plan
  assert.deepEqual(contextWindowHint(500000, info({ capacity: 272000, priceCap: rise() })), { kind: 'owner' });
  // nothing the Hub relies on carries no reason with it, and no cap is the note as before
  assert.deepEqual(contextWindowHint('', info({ trusted: false, capacity: null, priceCap: rise() })), { kind: 'unknown' });
  assert.deepEqual(contextWindowHint('', info({ priceCap: null })), { kind: 'catalog', tokens: '1,000,000', source: 'catalog@2026-10-19' });
  assert.deepEqual(contextWindowHint('', info({ contextWindow: 400000, maxInput: 272000, capacity: 288384, priceCap: null })).kind, 'catalog_limited');
});

test('the sentence of each note: which string, with which numbers; none for the owner\'s window or for nothing to rely on', () => {
  const said = (hint) => { const calls = []; const text = windowHintSentence((key, params) => { calls.push([key, params]); return `<${key}>`; }, hint); return { text, calls }; };
  assert.deepEqual(said({ kind: 'owner' }), { text: '', calls: [] });
  assert.deepEqual(said({ kind: 'unknown' }), { text: '', calls: [] });
  assert.deepEqual(said({ kind: 'catalog', tokens: '1,000,000', source: 'S' }), { text: '<ai_window_catalog>', calls: [['ai_window_catalog', { tokens: '1,000,000', source: 'S' }]] });
  assert.deepEqual(said({ kind: 'catalog_limited', tokens: '288,384', window: '400,000', input: '272,000', source: 'S' }).calls, [['ai_window_catalog_limited', { tokens: '288,384', window: '400,000', input: '272,000', source: 'S' }]]);
  const price = { kind: 'catalog_price', tokens: '272,000', window: '1,050,000', above: '272,000', from: '$2.5 / $15', to: '$5 / $22.5', floored: false, source: 'S' };
  assert.deepEqual(said(price).calls, [['ai_window_catalog_price', { tokens: '272,000', window: '1,050,000', above: '272,000', from: '$2.5 / $15', to: '$5 / $22.5', source: 'S' }]]);
  assert.deepEqual(said({ ...price, floored: true }).calls.map((call) => call[0]), ['ai_window_catalog_price_floor'], 'the floor has a sentence of its own');
});
