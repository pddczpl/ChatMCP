import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';

// The model picker as data (src/lib/model-picker.ts): which models the list shows, in which order, filtered how, with which badges. Kept out of the component so that the rules are testable
// without a browser: the account's own list wins over the catalog's when the Hub could ask the provider; a model is found by typing any part of its id; the badges say only what the catalog says
// (a number that is not there is not shown as zero), and a model the catalog marks deprecated is not offered (unless it is the one that is configured).
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { badgesOf, factsOf, filterChoices, formatPrice, formatTokens, keyAction, mergeChoices } from './src/lib/model-picker';
  export { badgesOf, factsOf, filterChoices, formatPrice, formatTokens, keyAction, mergeChoices };
`, 'chatmcp-model-picker-');
after(dispose);
const { badgesOf, factsOf, filterChoices, formatPrice, formatTokens, keyAction, mergeChoices } = loaded;

const entry = (id, extra = {}) => ({ id, contextWindow: 128000, maxInput: null, maxOutput: 8192, rates: { input: 1, output: 2 }, tiered: false, reasoning: false, toolCall: true, vision: false, status: null, ...extra });

test('a size is written the short way and never as a false number', () => {
  assert.deepEqual([1000000, 1048576, 2000000, 1500000, 400000, 272000, 128000, 8192, 4096, 1000, 999, 0].map(formatTokens), ['1M', '1M', '2M', '1.5M', '400K', '272K', '128K', '8K', '4K', '1K', '999', '0']);
  assert.deepEqual([999999, 999499, 999500].map(formatTokens), ['1M', '999K', '1M'], 'a size that rounds to a thousand thousands is a million');
  assert.deepEqual([null, undefined, Number.NaN, -5].map(formatTokens), [null, null, null, null], 'a size the catalog does not give is not written');
});

test('a price is USD per million tokens, without the zeros that mean nothing', () => {
  assert.equal(formatPrice({ input: 2, output: 10 }), '$2 / $10');
  assert.equal(formatPrice({ input: 0.25, output: 2 }), '$0.25 / $2');
  assert.equal(formatPrice({ input: 0.025, output: 22.5 }), '$0.025 / $22.5');
  assert.equal(formatPrice({ input: 0, output: 0 }), '$0 / $0', 'free is free');
  assert.equal(formatPrice({ input: 1.00004, output: 3 }), '$1 / $3');
  assert.equal(formatPrice(null), null);
  assert.equal(formatPrice({ input: Number.NaN, output: 1 }), null);
});

test('a model the catalog marks deprecated is not offered, from the account\'s list or the catalog\'s, unless it is the configured one; beta and alpha stay', () => {
  const catalog = [entry('fresh'), entry('gone', { status: 'deprecated' }), entry('beta-one', { status: 'beta' }), entry('alpha-one', { status: 'alpha' })];
  const account = ['fresh', 'gone', 'beta-one', 'alpha-one', 'mine'].map((id) => ({ id, name: id }));
  for (const [label, choices] of [['the catalog', mergeChoices(catalog, undefined)], ['the account', mergeChoices(catalog, account)]]) {
    assert.ok(!choices.some((choice) => choice.id === 'gone'), `${label}: the deprecated model is not offered`);
    assert.ok(['fresh', 'beta-one', 'alpha-one'].every((id) => choices.some((choice) => choice.id === id)), `${label}: models that are still served stay, beta and alpha too`);
  }
  assert.ok(mergeChoices(catalog, account).some((choice) => choice.id === 'mine'), 'a model the catalog does not know is offered when the account lists it');
  assert.equal(mergeChoices(catalog, account, { keep: ['gone'] }).at(-1).id, 'gone', 'the configured one stays, after the others');
  assert.ok(!mergeChoices(catalog, account, { keep: ['fresh'] }).some((choice) => choice.id === 'gone'), 'keeping another model does not bring it back');
});

test('the list is the account\'s when the Hub could ask the provider, else the catalog\'s; each model carries the facts the catalog has', () => {
  const catalog = [entry('claude-opus-5-5', { contextWindow: 1000000 }), entry('claude-sonnet-5-5', { contextWindow: 1000000, reasoning: true }), entry('claude-old', { status: 'deprecated' })];
  const fromCatalog = mergeChoices(catalog, undefined);
  assert.deepEqual(fromCatalog.map((choice) => choice.id), ['claude-opus-5-5', 'claude-sonnet-5-5'], 'sorted by id; the deprecated one is not offered');
  assert.deepEqual(fromCatalog.map((choice) => [choice.inCatalog, choice.listed]), [[true, false], [true, false]]);
  const configured = mergeChoices(catalog, undefined, { keep: ['claude-old'] });
  assert.deepEqual(configured.map((choice) => choice.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-old'], 'unless it is the one that is configured: then it is there, after the others');
  assert.equal(configured[2].status, 'deprecated');

  const account = [{ id: 'claude-sonnet-5-5', name: 'claude-sonnet-5-5' }, { id: 'my-finetune', name: 'my-finetune' }, { id: 'claude-opus-5-5', name: 'claude-opus-5-5' }];
  const mixed = mergeChoices(catalog, account);
  assert.deepEqual(mixed.map((choice) => choice.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'my-finetune'], 'only what the account lists, sorted');
  assert.deepEqual(mixed.map((choice) => [choice.inCatalog, choice.listed]), [[true, true], [true, true], [false, true]]);
  const mine = mixed[2];
  assert.deepEqual([mine.contextWindow, mine.rates, mine.reasoning, mine.toolCall, mine.status], [null, null, false, null, null], 'a model the catalog does not know has no facts, not zeros');
  assert.equal(mixed[1].contextWindow, 1000000);
  assert.deepEqual(mergeChoices(catalog, []).map((choice) => choice.listed), [false, false, false], 'an empty account list is no list');
  assert.deepEqual(mergeChoices(undefined, undefined), []);
  assert.deepEqual(mergeChoices(undefined, account).map((choice) => choice.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'my-finetune'], 'the account\'s list alone, without the catalog');
  assert.deepEqual(mergeChoices([entry('b'), entry('a'), entry('b')], undefined).map((choice) => choice.id), ['a', 'b'], 'an id appears once');
  assert.deepEqual(mergeChoices(catalog, [{ id: 'm', name: 'm' }, { id: 'm', name: 'm' }, { id: '', name: '' }]).map((choice) => choice.id), ['m'], 'so does an id the account lists twice, and an empty one is no model');

  // The Hub puts the model that is configured into the list when the provider does not list it (marked `listed: false`), so that the choice is not lost: it is not "in the account"
  const withConfigured = mergeChoices(catalog, [{ id: 'claude-opus-5-5', name: 'claude-opus-5-5' }, { id: 'my-deployment', name: 'my-deployment', configured: true, listed: false }]);
  assert.deepEqual(withConfigured.map((choice) => [choice.id, choice.listed]), [['claude-opus-5-5', true], ['my-deployment', false]], 'a model the provider did not list is not said to be in the account');
  assert.deepEqual(badgesOf(withConfigured[1]).map((badge) => badge.kind), [], 'and has no badge of that kind');
  const known = mergeChoices(catalog, [{ id: 'claude-sonnet-5-5', name: 'claude-sonnet-5-5', configured: true, listed: false }]);
  assert.deepEqual([known[0].inCatalog, known[0].listed], [true, false], 'the same for one the catalog knows');
});

test('typing any part of an id finds it, the best matches first, and the list is bounded', () => {
  const choices = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'o3-mini', 'claude-mini-x', 'mini'].map((id) => mergeChoices([entry(id)], undefined)[0]);
  assert.deepEqual(filterChoices(choices, '', 50).shown.map((choice) => choice.id), ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'o3-mini', 'claude-mini-x', 'mini'], 'no text: the list as it is');
  assert.deepEqual(filterChoices(choices, 'MINI', 50).shown.map((choice) => choice.id), ['mini', 'gpt-5-mini', 'o3-mini', 'claude-mini-x'], 'an exact id, then ids that start with it, then ids that contain it, ignoring case');
  assert.deepEqual(filterChoices(choices, 'gpt-5-', 50).shown.map((choice) => choice.id), ['gpt-5-mini', 'gpt-5-nano']);
  assert.deepEqual(filterChoices(choices, 'zzz', 50), { shown: [], total: 0 });
  const ids = (list, text) => filterChoices(list.map((id) => mergeChoices([entry(id)], undefined)[0]), text, 50).shown.map((choice) => choice.id);
  assert.deepEqual(ids(['gpt-5', 'gpt'], 'gpt'), ['gpt', 'gpt-5'], 'the id itself comes before the ones that start with it, wherever the list has it');
  assert.deepEqual(ids(['o3-mini', 'minimal'], 'mini'), ['minimal', 'o3-mini'], 'ids that start with the text come before the ones that only contain it');
  assert.deepEqual(ids(['GPT-5-Mini', 'Other'], 'mini'), ['GPT-5-Mini'], 'any case, in the id as well as in the text');
  assert.deepEqual(ids(['a', 'b'], '   '), ['a', 'b'], 'only spaces is no text');
  const many = Array.from({ length: 120 }, (_, index) => mergeChoices([entry(`m-${String(index).padStart(3, '0')}`)], undefined)[0]);
  const bounded = filterChoices(many, 'm-', 50);
  assert.deepEqual([bounded.shown.length, bounded.total], [50, 120], 'at most the limit is shown, the total is said');
  assert.deepEqual([filterChoices(many, '', 50).shown.length, filterChoices(many, '', 50).total], [50, 120], 'with no text too');
  assert.deepEqual(filterChoices(many, '  m-005  ', 50).shown.map((choice) => choice.id), ['m-005'], 'spaces around the text are not part of it');
});

test('the badges say what the catalog says and nothing else', () => {
  const kinds = (choice) => badgesOf(choice).map((badge) => badge.kind);
  const big = mergeChoices([entry('big', { contextWindow: 1000000, maxInput: null, rates: { input: 2, output: 10 }, reasoning: true, toolCall: true, vision: true })], undefined)[0];
  assert.deepEqual(badgesOf(big), [
    { kind: 'context', params: { size: '1M' } }, { kind: 'price', params: { price: '$2 / $10' } }, { kind: 'think' }, { kind: 'tools' }, { kind: 'vision' },
  ]);
  const limited = mergeChoices([entry('limited', { contextWindow: 400000, maxInput: 272000 })], undefined)[0];
  assert.deepEqual(badgesOf(limited)[0], { kind: 'context', params: { size: '400K', input: '272K' } }, 'an input limit below the window is said with the window');
  assert.deepEqual(badgesOf(mergeChoices([entry('same', { contextWindow: 128000, maxInput: 128000 })], undefined)[0])[0], { kind: 'context', params: { size: '128K' } }, 'an input limit equal to the window is not news');
  assert.ok(kinds(mergeChoices([entry('tiered', { tiered: true })], undefined)[0]).includes('tiered'), 'a price with tiers says so');
  assert.equal(kinds(mergeChoices([entry('plain', { reasoning: false, toolCall: false, vision: false })], undefined)[0]).some((kind) => ['think', 'tools', 'vision'].includes(kind)), false, 'a capability the model lacks is not a badge');
  const unknown = mergeChoices(undefined, [{ id: 'mine', name: 'mine' }])[0];
  assert.deepEqual(badgesOf(unknown), [{ kind: 'account' }], 'a model only the account lists has only that');
  const withStatus = (status) => badgesOf(mergeChoices([entry('s', { status })], undefined, { keep: ['s'] })[0]).find((badge) => badge.kind === 'status');
  assert.deepEqual([withStatus('beta'), withStatus('alpha'), withStatus('deprecated'), withStatus('not_stable'), withStatus(null)],
    [{ kind: 'status', params: { status: 'beta' } }, { kind: 'status', params: { status: 'alpha' } }, { kind: 'status', params: { status: 'deprecated' } }, { kind: 'status', params: { status: 'not_stable' } }, undefined]);
  const both = mergeChoices([entry('x')], [{ id: 'x', name: 'x' }])[0];
  assert.ok(kinds(both).includes('account'), 'a model the account lists says so');
  assert.deepEqual(badgesOf(mergeChoices([entry('free', { rates: { input: 0, output: 0 } })], undefined)[0]).find((badge) => badge.kind === 'price'), { kind: 'price', params: { price: '$0 / $0' } });
});

test('the line under the model field says what the catalog says about the model typed there, and whether the Hub relies on it', () => {
  const info = (extra = {}) => ({
    model: 'claude-sonnet-5-5', found: true, confidence: 'exact', trusted: true, catalogModel: 'claude-sonnet-5-5', source: 'catalog@2026-10-19', contextWindow: 1000000, maxInput: null, maxOutput: 128000,
    rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, tiers: [], status: null, toolCall: true, vision: true, local: false, reasoning: { supported: true }, ...extra,
  });
  const known = factsOf(info());
  assert.deepEqual([known.kind, known.id, known.source], ['known', 'claude-sonnet-5-5', 'catalog@2026-10-19']);
  assert.deepEqual(known.badges, [{ kind: 'context', params: { size: '1M' } }, { kind: 'price', params: { price: '$2 / $10' } }, { kind: 'think' }, { kind: 'tools' }, { kind: 'vision' }]);
  assert.equal(factsOf(info({ confidence: 'normalized' })).kind, 'known', 'the same model spelled another way is known');
  const alias = factsOf(info({ confidence: 'alias', trusted: false, catalogModel: 'gpt-5-mini', model: 'my-gpt' }));
  assert.deepEqual([alias.kind, alias.id], ['alias', 'gpt-5-mini'], 'an alias says which model it looks like');
  assert.deepEqual(factsOf(info({ tiers: [{ aboveTokens: 272000, rates: { input: 5, output: 22, cacheRead: null, cacheWrite: null } }], contextWindow: 1050000, maxInput: 922000, status: 'deprecated', vision: false, reasoning: { supported: false } })).badges.map((badge) => badge.kind),
    ['context', 'price', 'tiered', 'tools', 'status']);
  assert.equal(factsOf(info({ found: false, confidence: 'none', trusted: false })), null, 'a model the catalog does not know has no line');
  assert.equal(factsOf(undefined), null);
  assert.equal(factsOf(info({ local: true, found: false, confidence: 'none' })), null, 'nor does a local runtime');
  assert.equal(factsOf(info({ rates: null })).badges.some((badge) => badge.kind === 'price'), false, 'no price, no price badge');
});

test('the keyboard: the arrows open and move through the list, Enter takes the one that is active, Escape closes', () => {
  assert.deepEqual(keyAction('ArrowDown', false, 0, 5), { type: 'open' }, 'down opens a closed list');
  assert.deepEqual(keyAction('ArrowDown', true, 0, 5), { type: 'move', active: 1 });
  assert.deepEqual(keyAction('ArrowDown', true, 4, 5), { type: 'move', active: 4 }, 'it stops at the last one');
  assert.deepEqual(keyAction('ArrowDown', true, 0, 0), { type: 'move', active: 0 }, 'an empty list has only the first place');
  assert.deepEqual(keyAction('ArrowUp', true, 3, 5), { type: 'move', active: 2 });
  assert.deepEqual(keyAction('ArrowUp', true, 0, 5), { type: 'move', active: 0 }, 'and at the first');
  assert.deepEqual(keyAction('ArrowUp', false, 0, 5), { type: 'none' }, 'up does not open it');
  assert.deepEqual(keyAction('Enter', true, 2, 5), { type: 'pick', index: 2 });
  assert.deepEqual(keyAction('Enter', true, 0, 0), { type: 'none' }, 'nothing to take');
  assert.deepEqual(keyAction('Enter', true, 7, 5), { type: 'none' }, 'an active place the list no longer has');
  // typing leaves no model active (-1): the first key down goes to the first, and Enter keeps what was typed instead of taking the first match
  assert.deepEqual(keyAction('ArrowDown', true, -1, 5), { type: 'move', active: 0 }, 'from no active place, down goes to the first');
  assert.deepEqual(keyAction('ArrowUp', true, -1, 5), { type: 'move', active: 0 }, 'and up too');
  assert.deepEqual(keyAction('Enter', true, -1, 5), { type: 'none' }, 'with nothing active, Enter is left to the field: what was typed stays');
  assert.deepEqual(keyAction('Enter', false, 0, 5), { type: 'none' }, 'Enter in a closed field is left to the page');
  assert.deepEqual(keyAction('Escape', true, 0, 5), { type: 'close' });
  assert.deepEqual(keyAction('Escape', false, 0, 5), { type: 'none' });
  for (const key of ['a', 'Tab', 'Home', ' ']) assert.deepEqual(keyAction(key, true, 1, 5), { type: 'none' }, key);
});
