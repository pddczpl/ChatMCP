import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';
import { parseHtml, byTag, normalise } from './support/html.mjs';

// How the AI settings (the connection of the Hub, and the model profiles) use what the Hub knows about the model typed in them: the Model field is the picker, the note under the context window says
// where the window the Hub plans with comes from when the owner typed none, the account's own models can be asked for only for the connection the Hub holds, and the empty price fields of a model profile
// say what the catalog gives. The picker itself is tested in model-picker-component.test.mjs; these tests pin what the two forms hand to it and what they say with the Hub's answer.
const entry = `
  ${renderPrelude}
  import { QueryObserver } from '@tanstack/react-query';
  import { IntelligenceTab } from './src/components/inspector/IntelligenceTab';
  import { ModelProfilesPanel } from './src/components/inspector/ModelProfilesPanel';
  import { modelInfoKey } from './src/lib/reasoning-effort';
  import { translations } from './src/lib/i18n';
  export { IntelligenceTab, ModelProfilesPanel, QueryObserver, modelInfoKey, translations };
`;

// The states only a click reaches are started by rewriting the line that declares them; what they start as is read from globalThis when the component renders, so that one bundle serves every case.
const TAB_INITIAL = '(globalThis as any).__tabInitial';
const TAB = [
  { file: 'IntelligenceTab.tsx', from: "provider: (ai as any).preset || ai.provider || 'anthropic',", to: `provider: ${TAB_INITIAL}?.provider ?? ((ai as any).preset || ai.provider || 'anthropic'),` },
  { file: 'IntelligenceTab.tsx', from: "apiBaseUrl: ai.apiBaseUrl || 'https://api.anthropic.com',", to: `apiBaseUrl: ${TAB_INITIAL}?.apiBaseUrl ?? (ai.apiBaseUrl || 'https://api.anthropic.com'),` },
  { file: 'IntelligenceTab.tsx', from: "const [contextWindowDraft,setContextWindowDraft] = useState('');", to: `const [contextWindowDraft,setContextWindowDraft] = useState<string>(${TAB_INITIAL}?.draft ?? '');` },
  { file: 'IntelligenceTab.tsx', from: 'const [contextWindowDirty,setContextWindowDirty] = useState(false);', to: `const [contextWindowDirty,setContextWindowDirty] = useState<boolean>(${TAB_INITIAL}?.dirty ?? false);` },
];
const OPEN = { file: 'ModelPicker.tsx', from: 'const [open, setOpen] = useState(false);', to: 'const [open, setOpen] = useState(true);' };
const PROFILE = { file: 'ModelProfilesPanel.tsx', from: 'useState<ProfileDraft>(emptyProfileDraft)', to: 'useState<ProfileDraft>(() => ({ ...emptyProfileDraft(), ...((globalThis as any).__profileInitial ?? {}) }))' };

const tab = await bundleTsx(entry, 'chatmcp-wiring-tab-', { rewrites: TAB });
const tabOpen = await bundleTsx(entry, 'chatmcp-wiring-tab-open-', { rewrites: [...TAB, OPEN] });
const profile = await bundleTsx(entry, 'chatmcp-wiring-profile-', { rewrites: [PROFILE] });
const profileOpen = await bundleTsx(entry, 'chatmcp-wiring-profile-open-', { rewrites: [PROFILE, OPEN] });
after(async () => { for (const bundle of [tab, tabOpen, profile, profileOpen]) await bundle.dispose(); });
const { translations, modelInfoKey } = tab.loaded;

const SOURCE = 'catalog@2026-10-19';
const URL = 'https://api.anthropic.com';
const info = (extra = {}) => ({
  model: 'claude-sonnet-5-5', protocol: 'anthropic', preset: 'anthropic', found: true, confidence: 'exact', source: SOURCE, provider: 'anthropic', catalogModel: 'claude-sonnet-5-5', local: false,
  contextWindow: 1000000, maxInput: null, maxOutput: 128000, rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, tiers: [], status: null, toolCall: true, vision: true, trusted: true,
  capacity: 1000000, outputCap: 16384, reasoning: { supported: false, toggle: false, budget: null, efforts: [], levels: [], known: true, why: null },
  catalog: { generatedAt: '2026-10-19', ageDays: 5 }, ...extra,
});
const saved = (extra = {}) => ({ configured: true, preset: 'anthropic', provider: 'anthropic', protocol: 'anthropic', model: 'claude-sonnet-5-5', apiBaseUrl: URL, contextWindowTokens: null, ...extra });
const STATUS = { source: 'bundled', label: SOURCE, generatedAt: '2026-10-19', ageDays: 5, providers: 232, models: 9056, url: 'https://models.dev/api.json', refreshing: false, ignored: null, lastRefresh: null, bundled: { generatedAt: '2026-10-19', models: 9056 } };
const tabEntries = (ai, extra = []) => [[['hubState'], { ai, agent: { tasks: [] } }], [['aiProfiles'], { profiles: [], defaultProfileId: null }], ...extra];
const KEY = modelInfoKey('anthropic', 'anthropic', URL, 'claude-sonnet-5-5');

/** The model picker is a script of its own that the field fetches the first time it renders (React.lazy): the first render of a bundle shows the plain input it falls back to. */
const warmed = new WeakSet();
async function show(bundle, name, entries, { initial = {}, lang = 'vi' } = {}) {
  globalThis.__tabInitial = initial;
  globalThis.__profileInitial = initial;
  if (!warmed.has(bundle)) {
    warmed.add(bundle);
    await bundle.loaded.renderWith(bundle.loaded[name], {}, entries, [], { lang });
    await new Promise((resolve) => setImmediate(resolve));
  }
  return bundle.loaded.renderWith(bundle.loaded[name], {}, entries, [], { lang });
}
const withTestId = (root, id) => root.descendants().find((node) => node.attrs['data-testid'] === id);
const hintOf = (html) => { const node = withTestId(parseHtml(html), 'context-window-hint'); return { text: normalise(node.text), cls: node.attrs.class }; };
const ALLOWED = 'Allowed: 4,096 - 2,000,000 tokens (larger values are reduced to the maximum, smaller ones are refused). Leave empty if you do not know it.';
const sentence = (lang, key, params) => Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, value), translations[lang][key]);

// ---- the connection of the Hub ----

test('the Model field of the connection is the picker, with the line about the model typed in it and the Hub\'s list of models once', async () => {
  const entries = tabEntries(saved(), [[KEY, info()], [['catalogStatus'], STATUS]]);
  const root = parseHtml(await show(tab, 'IntelligenceTab', entries));
  // the tab holds the model profiles below the connection, and a profile has a model field of its own
  assert.deepEqual(byTag(root, 'input').filter((node) => node.attrs.role === 'combobox').map((node) => node.attrs.id), ['datgold-model', 'datgold-profile-model']);
  const combo = byTag(root, 'input').find((node) => node.attrs.id === 'datgold-model');
  assert.deepEqual([combo.attrs['aria-label'], combo.attrs.value, combo.attrs.placeholder], ['Model', 'claude-sonnet-5-5', translations.vi.ai_model_placeholder]);
  assert.match(combo.attrs.class, /font-mono/, 'the classes of the input that was there');
  assert.equal(normalise(withTestId(root, 'model-facts').text), 'Danh mục (catalog@2026-10-19): 1M ngữ cảnh $2 / $10 mỗi 1M token công cụ đọc ảnh', 'what the Hub knows of the model typed in the form');
  assert.equal(root.descendants().filter((node) => node.attrs['data-testid'] === 'catalog-status').length, 1, 'the Hub\'s list of models is named once, here');
});

test('the note under the context window says where the window comes from: the owner\'s, the catalog\'s, or none', async () => {
  const given = (extra, ai = saved()) => tabEntries(ai, extra === undefined ? [] : [[KEY, info(extra)]]);
  // none typed, and the Hub is sure of the model: the catalog's window, and nothing is written into the field
  const catalog = hintOf(await show(tab, 'IntelligenceTab', given({})));
  assert.equal(catalog.text, `${sentence('vi', 'ai_window_catalog', { tokens: '1,000,000', source: SOURCE })} ${ALLOWED}`);
  assert.match(catalog.cls, /text-faint/);
  assert.doesNotMatch(catalog.cls, /text-warning/, 'the Hub has a window to plan on: not a warning');
  assert.equal(hintOf(await show(tab, 'IntelligenceTab', given({}), { lang: 'en' })).text, `${sentence('en', 'ai_window_catalog', { tokens: '1,000,000', source: SOURCE })} ${ALLOWED}`);
  // a model that takes in less than its window
  const limited = hintOf(await show(tab, 'IntelligenceTab', given({ contextWindow: 400000, maxInput: 272000, capacity: 288384 })));
  assert.equal(limited.text, `${sentence('vi', 'ai_window_catalog_limited', { tokens: '288,384', window: '400,000', input: '272,000', source: SOURCE })} ${ALLOWED}`);
  // the owner's window, saved
  const owner = hintOf(await show(tab, 'IntelligenceTab', given({}, saved({ contextWindowTokens: 64000 }))));
  assert.equal(owner.text, ALLOWED, 'the owner set one: the note does not talk about the catalog or about unknown');
  assert.match(owner.cls, /text-faint/);
  // nothing the Hub relies on: unknown, said as a warning
  for (const [label, entries] of [['the Hub has not answered', given(undefined)], ['an alias', given({ confidence: 'alias', trusted: false, capacity: null })], ['a model the catalog does not know', given({ found: false, confidence: 'none', trusted: false, capacity: null, contextWindow: null })]]) {
    const unknown = hintOf(await show(tab, 'IntelligenceTab', entries));
    assert.equal(unknown.text, `Unknown: the agent plans with a conservative estimate and shows a warning on every task. ${ALLOWED}`, label);
    assert.match(unknown.cls, /text-warning/, label);
  }
});

test('while the window is being edited the note follows the text in the field, not the saved window', async () => {
  const entries = tabEntries(saved({ contextWindowTokens: 64000 }), [[KEY, info()]]);
  const catalogSentence = `${sentence('vi', 'ai_window_catalog', { tokens: '1,000,000', source: SOURCE })} ${ALLOWED}`;
  assert.equal(hintOf(await show(tab, 'IntelligenceTab', entries, { initial: { dirty: true, draft: '' } })).text, catalogSentence, 'the field was emptied: the catalog\'s window applies once it is saved');
  assert.equal(hintOf(await show(tab, 'IntelligenceTab', entries, { initial: { dirty: true, draft: '300000' } })).text, ALLOWED, 'a number was typed: it is the owner\'s');
  assert.equal(hintOf(await show(tab, 'IntelligenceTab', entries, { initial: { dirty: false, draft: '' } })).text, ALLOWED, 'not edited: the saved window');
  const unsaved = tabEntries(saved(), [[KEY, info()]]);
  assert.equal(hintOf(await show(tab, 'IntelligenceTab', unsaved, { initial: { dirty: true, draft: '300000' } })).text, ALLOWED, 'typed over nothing saved');
});

/** What the form asks the Hub about the model in it: every part of the form that wants it asks the same thing. */
async function modelInfoQueries(bundle, name, entries, initial = {}) {
  const { QueryObserver } = bundle.loaded;
  const seen = [];
  const original = QueryObserver.prototype.getOptimisticResult;
  QueryObserver.prototype.getOptimisticResult = function (options) { if (options.queryKey[0] === 'modelInfo') seen.push({ key: options.queryKey, enabled: options.enabled }); return original.call(this, options); };
  try { await show(bundle, name, entries, { initial }); } finally { QueryObserver.prototype.getOptimisticResult = original; }
  return seen;
}

test('the form asks the Hub about the preset when it is one, and about the protocol of the connection; a Hub with no preset is asked about its protocol alone', async () => {
  // the profiles below the connection ask about a model of their own (none, until one is typed): only what is asked about the connection's model is looked at
  const same = (queries, model) => {
    const mine = queries.filter((query) => query.key[4] === model);
    assert.ok(mine.length >= 3, `the model field, the thinking-effort field and the window note all ask: ${mine.length}`);
    assert.equal(new Set(mine.map((query) => JSON.stringify(query))).size, 1, 'and ask the same thing');
    return mine[0];
  };
  const anthropic = same(await modelInfoQueries(tab, 'IntelligenceTab', tabEntries(saved())), 'claude-sonnet-5-5');
  assert.deepEqual([anthropic.key, anthropic.enabled], [['modelInfo', 'anthropic', 'anthropic', URL, 'claude-sonnet-5-5'], true]);
  const custom = same(await modelInfoQueries(tab, 'IntelligenceTab', tabEntries(saved({ preset: 'custom-openai', provider: 'custom-openai', protocol: 'openai-chat', model: 'local-model', apiBaseUrl: 'https://gw.example/v1' }))), 'local-model');
  assert.deepEqual(custom.key, ['modelInfo', 'custom-openai', 'openai-chat', 'https://gw.example/v1', 'local-model'], 'the protocol of the preset');
  // a Hub that holds a connection saved without a preset calls its provider "gateway", which is not a preset the Hub knows: the protocol it reports is all there is to ask about
  const gateway = same(await modelInfoQueries(tab, 'IntelligenceTab', tabEntries({ configured: true, provider: 'gateway', protocol: 'openai-chat', model: 'local-model', apiBaseUrl: 'https://gw.example/v1' })), 'local-model');
  assert.deepEqual([gateway.key, gateway.enabled], [['modelInfo', '', 'openai-chat', 'https://gw.example/v1', 'local-model'], true]);
});

test('the account\'s own models can be asked for only for the connection the Hub holds, with its saved key', async () => {
  const button = (html) => byTag(parseHtml(html), 'button').some((node) => normalise(node.text) === translations.vi.ai_model_load_account);
  const saveFirst = (html) => parseHtml(html).text.includes(translations.vi.ai_model_account_save_first);
  const entries = (ai) => tabEntries(ai, [[KEY, info()]]);
  const same = await show(tabOpen, 'IntelligenceTab', entries(saved()));
  assert.deepEqual([button(same), saveFirst(same)], [true, false], 'the form is the saved connection');
  const spaced = await show(tabOpen, 'IntelligenceTab', entries(saved()), { initial: { apiBaseUrl: `  ${URL} ` } });
  assert.deepEqual([button(spaced), saveFirst(spaced)], [true, false], 'spaces around the address are not a different connection');
  for (const [label, html] of [
    ['no connection is saved', await show(tabOpen, 'IntelligenceTab', entries(saved({ configured: false })))],
    ['another provider is chosen', await show(tabOpen, 'IntelligenceTab', entries(saved()), { initial: { provider: 'openai' } })],
    ['another address is typed', await show(tabOpen, 'IntelligenceTab', entries(saved()), { initial: { apiBaseUrl: 'https://other.example' } })],
  ]) assert.deepEqual([button(html), saveFirst(html)], [false, true], `${label}: not the connection the Hub holds`);
});

// ---- the model profiles ----

const PROFILE_DRAFT = { model: 'gpt-5-mini', protocol: 'openai-chat', apiBaseUrl: 'https://api.openai.com/v1' };
const PROFILE_KEY = modelInfoKey(undefined, 'openai-chat', 'https://api.openai.com/v1', 'gpt-5-mini');
const profileEntries = (extra = []) => [[['aiProfiles'], { profiles: [], defaultProfileId: null }], ...extra];
const rateInputs = (html) => Object.fromEntries(byTag(parseHtml(html), 'input').filter((node) => /^Model rate /.test(node.attrs['aria-label'] ?? '')).map((node) => [node.attrs['aria-label'].replace('Model rate ', ''), node.attrs.placeholder]));
const rateInfo = (extra = {}) => info({ model: 'gpt-5-mini', protocol: 'openai-chat', preset: null, provider: 'openai', catalogModel: 'gpt-5-mini', rates: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: null }, ...extra });

test('a model profile: the empty price fields say what the catalog gives, only for a model the Hub is sure of', async () => {
  const entries = (data) => profileEntries(data ? [[PROFILE_KEY, data]] : []);
  assert.deepEqual(rateInputs(await show(profile, 'ModelProfilesPanel', entries(rateInfo()), { initial: PROFILE_DRAFT })), { Input: '0.25', Output: '2', 'Cache read': '0.025', 'Cache write': undefined }, 'a price the catalog does not have is not made up');
  for (const [label, data] of [['the Hub has not answered', undefined], ['an alias', rateInfo({ confidence: 'alias', trusted: false })], ['no prices in the catalog', rateInfo({ rates: null })]]) {
    assert.deepEqual(rateInputs(await show(profile, 'ModelProfilesPanel', entries(data), { initial: PROFILE_DRAFT })), { Input: undefined, Output: undefined, 'Cache read': undefined, 'Cache write': undefined }, label);
  }
  // an owner's own price stays what it is: the placeholder is only for an empty field
  const typed = byTag(parseHtml(await show(profile, 'ModelProfilesPanel', entries(rateInfo()), { initial: { ...PROFILE_DRAFT, rateInput: '1.5' } })), 'input').find((node) => node.attrs['aria-label'] === 'Model rate Input');
  assert.equal(typed.attrs.value, '1.5');
  assert.match(parseHtml(await show(profile, 'ModelProfilesPanel', entries(), { initial: PROFILE_DRAFT })).text, /Leave a rate empty to use the model catalog's price as an estimate/);
});

test('a model profile: the note under the window says what the Hub uses when the field is empty', async () => {
  const note = (html) => normalise(byTag(parseHtml(html), 'label').find((node) => (node.attrs['aria-label'] ?? '') === '' && /tokens\./.test(node.text) && /Larger values/.test(node.text)).text);
  const entries = (data) => profileEntries(data ? [[PROFILE_KEY, data]] : []);
  const catalog = note(await show(profile, 'ModelProfilesPanel', entries(rateInfo({ capacity: 400000 })), { initial: PROFILE_DRAFT }));
  assert.ok(catalog.includes(sentence('vi', 'ai_window_catalog', { tokens: '400,000', source: SOURCE })), catalog);
  assert.ok(!catalog.includes('Empty = unknown'), 'the Hub does have a window to plan on');
  const limited = note(await show(profile, 'ModelProfilesPanel', entries(rateInfo({ contextWindow: 400000, maxInput: 272000, capacity: 288384 })), { initial: PROFILE_DRAFT }));
  assert.ok(limited.includes(sentence('vi', 'ai_window_catalog_limited', { tokens: '288,384', window: '400,000', input: '272,000', source: SOURCE })), limited);
  for (const [label, data, initial] of [['the Hub has not answered', undefined, PROFILE_DRAFT], ['a window typed', rateInfo(), { ...PROFILE_DRAFT, contextWindow: '64000' }], ['an alias', rateInfo({ confidence: 'alias', trusted: false, capacity: null }), PROFILE_DRAFT]]) {
    const text = note(await show(profile, 'ModelProfilesPanel', entries(data), { initial }));
    assert.ok(text.includes('Empty = unknown: the agent then plans with a conservative estimate and shows a warning.'), label);
    assert.ok(!text.includes('model catalog') && !text.includes('danh mục'), label);
  }
});

test('a model profile\'s Model field is the picker too, with neither the account\'s models (a profile is not the Hub\'s connection) nor the Hub\'s list of models', async () => {
  const html = await show(profileOpen, 'ModelProfilesPanel', profileEntries([[PROFILE_KEY, rateInfo()], [['catalogStatus'], STATUS]]), { initial: PROFILE_DRAFT });
  const root = parseHtml(html);
  const [combo] = byTag(root, 'input').filter((node) => node.attrs.role === 'combobox');
  assert.deepEqual([combo?.attrs.id, combo?.attrs['aria-label'], combo?.attrs.value], ['datgold-profile-model', 'Model profile model', 'gpt-5-mini']);
  assert.ok(withTestId(root, 'model-facts'), 'the line about the model typed in the form');
  assert.ok(!byTag(root, 'button').some((node) => normalise(node.text) === translations.vi.ai_model_load_account), 'no account button');
  assert.ok(!root.text.includes(translations.vi.ai_model_account_save_first), 'and no hint about saving first');
  assert.equal(withTestId(root, 'catalog-status'), undefined, 'the Hub\'s list of models is named in the connection, not in every profile');
  // it asks the Hub about the protocol of the profile (a profile has no preset)
  const queries = await modelInfoQueries(profile, 'ModelProfilesPanel', profileEntries(), PROFILE_DRAFT);
  assert.ok(queries.length >= 3 && queries.every((query) => JSON.stringify(query.key) === JSON.stringify(PROFILE_KEY) && query.enabled === true), JSON.stringify(queries));
});
