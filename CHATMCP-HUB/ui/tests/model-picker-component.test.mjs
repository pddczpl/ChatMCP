import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';
import { parseHtml, byTag, byRole, accessibleName, brokenReferences, duplicateIds, unnamedControls } from './support/html.mjs';

// The model picker (the field under "Model" of the AI settings and of the model profiles) and the line that tells which list of models the Hub knows and updates it. They are a script of their
// own, fetched when the AI settings open, so the field must work without them (ModelField shows the plain input until the script is there, and when it never comes). What these tests pin:
// the words in both languages, what is said about the model typed in the field and whether the Hub relies on it, the list (ordered, badged, filtered), the refresh button and what it asks of the Hub.
const entry = `
  ${renderPrelude}
  import { QueryObserver } from '@tanstack/react-query';
  import { ModelPicker } from './src/components/inspector/ModelPicker';
  import { ModelField, PickerBoundary } from './src/components/inspector/ModelField';
  import { CatalogStatusLine } from './src/components/inspector/CatalogStatus';
  import { modelInfoKey } from './src/lib/reasoning-effort';
  import { accountOutcome } from './src/lib/model-picker';
  import { translations, translate } from './src/lib/i18n';
  import { useAppStore } from './src/store/useAppStore';
  export { ModelPicker, ModelField, PickerBoundary, CatalogStatusLine, modelInfoKey, accountOutcome, translations, translate, useAppStore, QueryObserver };
`;
const OPEN = { file: 'ModelPicker.tsx', from: 'const [open, setOpen] = useState(false);', to: 'const [open, setOpen] = useState(true);' };
const TYPED = { file: 'ModelPicker.tsx', from: 'const [typed, setTyped] = useState(false);', to: 'const [typed, setTyped] = useState(true);' };
// The state of the picker and of the update button, started where a test says (globalThis.__pickerInitial / __statusInitial, read when the component renders) and logged as it is set
// (globalThis.__picker / __status): what a click does to the state is what the person then sees, and a server render never gets to see it.
const PICKER = '(globalThis as any)';
const LOGGED = [
  { file: 'ModelPicker.tsx', from: 'const [open, setOpen] = useState(false);', to: `const [open, setOpenState] = useState<boolean>(${PICKER}.__pickerInitial?.open ?? false); const setOpen = (value: any) => { (${PICKER}.__picker ??= []).push(['open', typeof value === 'function' ? value(open) : value]); setOpenState(value); };` },
  { file: 'ModelPicker.tsx', from: 'const [typed, setTyped] = useState(false);', to: `const [typed, setTypedState] = useState<boolean>(${PICKER}.__pickerInitial?.typed ?? false); const setTyped = (value: any) => { (${PICKER}.__picker ??= []).push(['typed', value]); setTypedState(value); };` },
  { file: 'ModelPicker.tsx', from: 'const [active, setActive] = useState(0);', to: `const [active, setActiveState] = useState<number>(${PICKER}.__pickerInitial?.active ?? 0); const setActive = (value: any) => { (${PICKER}.__picker ??= []).push(['active', value]); setActiveState(value); };` },
  { file: 'ModelPicker.tsx', from: 'const [account, setAccount] = useState<{ for?: string; models?: AccountModel[]; message?: string; busy?: boolean }>({});', to: `const [account, setAccountState] = useState<{ for?: string; models?: AccountModel[]; message?: string; busy?: boolean }>(${PICKER}.__pickerInitial?.account ?? {}); const setAccount = (value: any) => { (${PICKER}.__picker ??= []).push(['account', typeof value === 'function' ? value(account) : value]); setAccountState(value); };` },
  { file: 'CatalogStatus.tsx', from: 'const [busy, setBusy] = useState(false);', to: `const [busy, setBusyState] = useState<boolean>(${PICKER}.__statusInitial?.busy ?? false); const setBusy = (value: boolean) => { (${PICKER}.__status ??= []).push(['busy', value]); setBusyState(value); };` },
  { file: 'CatalogStatus.tsx', from: "const [problem, setProblem] = useState('');", to: `const [problem, setProblemState] = useState<string>(${PICKER}.__statusInitial?.problem ?? ''); const setProblem = (value: string) => { (${PICKER}.__status ??= []).push(['problem', value]); setProblemState(value); };` },
];
const plain = await bundleTsx(entry, 'chatmcp-picker-');
const opened = await bundleTsx(entry, 'chatmcp-picker-open-', { rewrites: [OPEN] });
const filtering = await bundleTsx(entry, 'chatmcp-picker-typed-', { rewrites: [OPEN, TYPED] });
const clicks = await bundleTsx(entry, 'chatmcp-picker-clicks-', { recordJsx: true });
const openClicks = await bundleTsx(entry, 'chatmcp-picker-open-clicks-', { recordJsx: true, rewrites: [OPEN] });
const logging = await bundleTsx(entry, 'chatmcp-picker-log-', { recordJsx: true, rewrites: LOGGED });
after(async () => { for (const bundle of [plain, opened, filtering, clicks, openClicks, logging]) await bundle.dispose(); });
const { translations, modelInfoKey, accountOutcome, PickerBoundary } = plain.loaded;

const DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const SOURCE = 'catalog@2026-10-19';
const info = (extra = {}) => ({
  model: 'claude-sonnet-5-5', protocol: 'anthropic', preset: 'anthropic', found: true, confidence: 'exact', source: SOURCE, provider: 'anthropic', catalogModel: 'claude-sonnet-5-5', local: false,
  contextWindow: 1000000, maxInput: null, maxOutput: 128000, rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, tiers: [], status: null, toolCall: true, vision: true, trusted: true,
  capacity: 1000000, outputCap: 16384, reasoning: { supported: true, toggle: false, budget: null, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], levels: ['low', 'medium', 'high', 'xhigh', 'max'], known: true, why: null },
  catalog: { generatedAt: '2026-10-19', ageDays: 5 }, ...extra,
});
const model = (id, extra = {}) => ({ id, contextWindow: 1000000, maxInput: null, maxOutput: 128000, rates: { input: 3, output: 15 }, tiered: false, reasoning: true, toolCall: true, vision: true, status: null, ...extra });
const LIST = { provider: 'anthropic', source: SOURCE, local: false, total: 3, truncated: false, models: [model('claude-haiku-3', { status: 'deprecated', contextWindow: 200000, rates: { input: 0.25, output: 1.25 }, reasoning: false, vision: false }), model('claude-opus-5-5', { rates: { input: 5, output: 25 } }), model('claude-sonnet-5-5', { rates: { input: 2, output: 10 } })] };
/** What a connection is to the picker: the preset, the address and how many times the form was saved (a new key makes the same address another account). What the account's models were asked for belongs to it. */
const CONNECTION = 'anthropic|https://api.anthropic.com|0';
const props = (extra = {}) => ({ id: 'm', ariaLabel: 'Model', value: 'claude-sonnet-5-5', onChange() {}, placeholder: 'model id', inputClassName: 'w-full', preset: 'anthropic', protocol: 'anthropic', apiBaseUrl: 'https://api.anthropic.com', ...extra });
const infoEntry = (p, data) => [modelInfoKey(p.preset, p.protocol, p.apiBaseUrl, p.value), data];
const listEntry = (p, data) => [['catalogModels', p.preset ?? '', p.apiBaseUrl.trim()], data];
const render = (bundle, name, p, entries, lang) => bundle.loaded.renderWith(bundle.loaded[name], p, entries, [], { lang });
const picker = (bundle, p, entries, lang = 'vi') => render(bundle, 'ModelPicker', p, entries, lang);
const textOf = (node) => node.text.replace(/\s+/g, ' ').trim();
const findTestId = (root, id) => byTag(root, 'p', 'div').find((node) => node.attrs['data-testid'] === id);

test('closed, the field is the input that was there, now a combobox, with a button to browse and a line about the model typed in it', async () => {
  const p = props();
  const root = parseHtml(await picker(plain, p, [infoEntry(p, info())]));
  const [input] = byTag(root, 'input');
  assert.deepEqual([input.attrs.role, input.attrs['aria-expanded'], input.attrs['aria-label'], input.attrs.value, input.attrs.type, input.attrs.placeholder], ['combobox', 'false', 'Model', 'claude-sonnet-5-5', 'text', 'model id']);
  const browse = byTag(root, 'button').find((node) => accessibleName(root, node) === translations.vi.ai_model_browse);
  assert.ok(browse && browse.attrs['aria-expanded'] === 'false' && browse.attrs['aria-haspopup'] === 'listbox');
  assert.equal(byRole(root, 'listbox').length, 0, 'no list while closed');
  assert.deepEqual([input.attrs['aria-controls'], input.attrs['aria-activedescendant']], [undefined, undefined], 'a closed field points at no list');
  const facts = findTestId(root, 'model-facts');
  assert.ok(facts, 'the catalog knows the model: a line says so');
  assert.equal(textOf(facts), 'Danh mục (catalog@2026-10-19): 1M ngữ cảnh $2 / $10 mỗi 1M token suy luận công cụ đọc ảnh');
  assert.doesNotMatch(facts.attrs.class, /text-warning/, 'a model the Hub relies on is not a warning');
  assert.deepEqual([duplicateIds(root), brokenReferences(root), unnamedControls(root)], [[], [], []], 'ids are unique, references point somewhere, every control has a name');
});

test('the line under the field: an input limit and tiers are said; an alias is shown but the Hub says it does not rely on it; an unknown model has no line', async () => {
  const p = props();
  const limited = parseHtml(await picker(plain, p, [infoEntry(p, info({ contextWindow: 400000, maxInput: 272000, tiers: [{ aboveTokens: 272000, rates: { input: 5, output: 22, cacheRead: null, cacheWrite: null } }], status: 'beta' }))]));
  assert.equal(textOf(findTestId(limited, 'model-facts')), 'Danh mục (catalog@2026-10-19): 400K ngữ cảnh, đầu vào tối đa 272K $2 / $10 mỗi 1M token giá theo bậc suy luận công cụ đọc ảnh beta');
  const alias = parseHtml(await picker(plain, p, [infoEntry(p, info({ confidence: 'alias', trusted: false, catalogModel: 'gpt-5-mini', model: 'my-gpt' }))]));
  const aliasLine = findTestId(alias, 'model-facts');
  assert.equal(textOf(aliasLine), 'Giống gpt-5-mini trong danh mục (catalog@2026-10-19), nhưng Hub không dựa vào đó để lập kế hoạch hay tính giá.');
  assert.match(aliasLine.attrs.class, /text-warning/, 'said as a warning');
  for (const none of [undefined, info({ found: false, confidence: 'none', trusted: false, catalogModel: null }), info({ local: true, found: false, confidence: 'none', trusted: false, catalogModel: null })]) {
    assert.equal(findTestId(parseHtml(await picker(plain, p, none ? [infoEntry(p, none)] : [])), 'model-facts'), undefined, 'a model the catalog does not know has no line');
  }
});

test('open, the list is the Hub\'s list of the provider: deprecated last, each model with its badges, the current one selected, the source named', async () => {
  const p = props();
  const root = parseHtml(await picker(opened, p, [infoEntry(p, info()), listEntry(p, LIST)]));
  const [input] = byTag(root, 'input');
  assert.equal(input.attrs['aria-expanded'], 'true');
  assert.equal(byTag(root, 'button').find((node) => accessibleName(root, node) === translations.vi.ai_model_browse).attrs['aria-expanded'], 'true', 'and so does the button that opened it');
  const [listbox] = byRole(root, 'listbox');
  assert.ok(listbox, 'a list');
  assert.equal(input.attrs['aria-controls'], listbox.attrs.id);
  assert.equal(accessibleName(root, listbox), translations.vi.ai_model_list_label);
  const options = byRole(root, 'option');
  assert.deepEqual(options.map((node) => node.attrs.id.split('-').pop()), ['0', '1', '2']);
  assert.deepEqual(options.map((node) => textOf(node).split(' ')[0]), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-3'], 'by id, with the deprecated model after the others');
  assert.deepEqual(options.map((node) => node.attrs['aria-selected']), ['false', 'true', 'false'], 'the model in the field is the selected one');
  assert.equal(textOf(options[0]), 'claude-opus-5-5 1M ngữ cảnh $5 / $25 mỗi 1M token suy luận công cụ đọc ảnh');
  assert.equal(textOf(options[2]), 'claude-haiku-3 200K ngữ cảnh $0.25 / $1.25 mỗi 1M token công cụ ngừng hỗ trợ', 'no thinking, no images: no badge');
  assert.equal(input.attrs['aria-activedescendant'], options[0].attrs.id, 'the first one is the active one');
  assert.deepEqual(options.map((node) => /bg-hover/.test(node.attrs.class)), [true, false, false], 'and it is marked');
  assert.deepEqual(options.map((node) => /text-primary/.test(node.attrs.class)), [false, true, false], 'as is the one that is chosen');
  assert.ok(textOf(root.descendants().find((node) => node.attrs['data-testid'] === 'model-list-note')).includes(`Danh sách: ${SOURCE}`));
  assert.deepEqual([duplicateIds(root), brokenReferences(root), unnamedControls(root)], [[], [], []]);
});

test('open: loading, a provider the Hub has no list for, a filter that matches nothing, a list too long to show whole', async () => {
  const p = props();
  const note = (html) => textOf(parseHtml(html).descendants().find((node) => node.attrs['data-testid'] === 'model-list-note'));
  assert.equal(note(await picker(opened, p, [infoEntry(p, info())])), translations.vi.ai_model_loading, 'the list has not come yet');
  assert.equal(note(await picker(opened, p, [listEntry(p, { provider: null, source: SOURCE, local: true, total: 0, truncated: false, models: [] })])), translations.vi.ai_model_no_catalog);
  const empty = parseHtml(await picker(opened, p, [listEntry(p, { provider: null, source: SOURCE, local: true, total: 0, truncated: false, models: [] })]));
  assert.deepEqual([byRole(empty, 'combobox')[0].attrs['aria-expanded'], byRole(empty, 'combobox')[0].attrs['aria-activedescendant'], byRole(empty, 'option').length, brokenReferences(empty)], ['true', undefined, 0, []], 'opened on purpose, the list says why it is empty, and no option is active');
  // a list that typing opened is drawn only when it has something to offer: a person typing a name the catalog does not have (a new model, an Ollama tag) is not shown a box that says there is no list
  for (const [label, value, entries] of [
    ['text that no model has', 'zzz', [listEntry(p, LIST)]],
    ['a connection the Hub has no list for', 'qwen2.5-coder:7b', [listEntry(p, { provider: null, source: SOURCE, local: true, total: 0, truncated: false, models: [] })]],
    ['a list that has not come yet', 'claude', []],
  ]) {
    const typedRoot = parseHtml(await picker(filtering, props({ value }), entries));
    const [combo] = byRole(typedRoot, 'combobox');
    const browse = byTag(typedRoot, 'button').find((node) => accessibleName(typedRoot, node) === translations.vi.ai_model_browse);
    assert.deepEqual([byRole(typedRoot, 'listbox').length, findTestId(typedRoot, 'model-list-note'), combo.attrs['aria-expanded'], combo.attrs['aria-controls'], combo.attrs['aria-activedescendant'], browse.attrs['aria-expanded']], [0, undefined, 'false', undefined, undefined, 'false'], `${label}: no box, and the field and its button say it is closed`);
  }
  assert.equal(note(await picker(opened, props({ preset: undefined, apiBaseUrl: '  ' }), [])), translations.vi.ai_model_no_catalog, 'nothing to ask about: no list is on its way');
  const failed = await opened.loaded.renderWith(opened.loaded.ModelPicker, p, [], [[['catalogModels', p.preset, p.apiBaseUrl], 'boom']], { lang: 'vi' });
  assert.equal(note(failed), translations.vi.ai_model_no_catalog, 'a list that could not be had: the same, and the field still takes a typed name');
  const many = { ...LIST, total: 300, models: Array.from({ length: 120 }, (_, index) => model(`m-${String(index).padStart(3, '0')}`)) };
  const html = await picker(opened, p, [listEntry(p, many)]);
  assert.equal(byRole(parseHtml(html), 'option').length, 50, 'at most 50 are shown');
  assert.ok(note(html).includes('Hiển thị 50 trong 300 model. Gõ để lọc.'), 'the total the Hub reports, not the 120 it sent');
  const typed = parseHtml(await picker(filtering, props({ value: 'M-01' }), [listEntry(p, many)]));
  assert.deepEqual(byRole(typed, 'option').map((node) => textOf(node).split(' ')[0]).slice(0, 3), ['m-010', 'm-011', 'm-012'], 'typing filters the list, any case');
});

test('the account\'s own models: a button when the form is the saved connection, a hint when it is not, nothing for a profile', async () => {
  const p = props();
  const entries = [infoEntry(p, info()), listEntry(p, LIST)];
  const withButton = parseHtml(await picker(opened, { ...p, canListAccount: true }, entries));
  assert.ok(byTag(withButton, 'button').some((node) => textOf(node) === translations.vi.ai_model_load_account), 'the button');
  const hinted = parseHtml(await picker(opened, { ...p, canListAccount: false }, entries));
  assert.ok(!byTag(hinted, 'button').some((node) => textOf(node) === translations.vi.ai_model_load_account));
  assert.ok(hinted.text.includes(translations.vi.ai_model_account_save_first), 'save first');
  const none = parseHtml(await picker(opened, p, entries));
  assert.ok(!none.text.includes(translations.vi.ai_model_account_save_first) && !byTag(none, 'button').some((node) => textOf(node) === translations.vi.ai_model_load_account), 'a profile: neither');
});

test('the field works without the picker: the plain input until its script is there, and for good when the script never comes', async () => {
  const p = props();
  const root = parseHtml(await render(plain, 'ModelField', p, [infoEntry(p, info())], 'vi'));
  const inputs = byTag(root, 'input');
  assert.equal(inputs.length, 1, 'one input');
  assert.deepEqual([inputs[0].attrs['aria-label'], inputs[0].attrs.value, inputs[0].attrs.placeholder, inputs[0].attrs.id, inputs[0].attrs.role, inputs[0].attrs.class], ['Model', 'claude-sonnet-5-5', 'model id', 'm', undefined, 'w-full'], 'the input that was there, and nothing else');
  assert.equal(byTag(root, 'button').length, 0);
  // the boundary around the lazy script: a script that cannot be had shows the same input instead of taking the page down
  assert.deepEqual(PickerBoundary.getDerivedStateFromError(new Error('chunk')), { failed: true });
  const boundary = new PickerBoundary({ fallback: 'plain input', children: 'picker' });
  boundary.state = { failed: false };
  assert.equal(boundary.render(), 'picker');
  boundary.state = { failed: true };
  assert.equal(boundary.render(), 'plain input');
});

test('what the answer about the account\'s models turns into: the list only when the provider answered', () => {
  const t = (key, params) => `${key}:${JSON.stringify(params ?? {})}`;
  const models = [{ id: 'a', name: 'a' }];
  assert.deepEqual(accountOutcome({ models, source: 'provider' }, t), { ok: true, models, message: 'ai_model_account_loaded:{"n":1}' });
  assert.deepEqual(accountOutcome({ models, source: 'configured', warning: 'Nhập API key để tải danh sách model.' }, t), { ok: false, message: 'Nhập API key để tải danh sách model.' }, 'the configured model alone is no list');
  assert.deepEqual(accountOutcome({ models: [], source: 'provider' }, t), { ok: false, message: 'ai_model_account_failed:{}' });
  assert.deepEqual(accountOutcome(undefined, t), { ok: false, message: 'ai_model_account_failed:{}' });
  // the model that is configured and that the provider did not list is in the list the Hub sends (so that the choice is not lost), but it is not one the account has
  const added = [{ id: 'a', name: 'a' }, { id: 'b', name: 'b', configured: true, listed: false }];
  assert.deepEqual(accountOutcome({ models: added, source: 'provider' }, t), { ok: true, models: added, message: 'ai_model_account_loaded:{"n":1}' }, 'it is not counted');
  assert.deepEqual(accountOutcome({ models: [added[1]], source: 'provider' }, t), { ok: false, message: 'ai_model_account_failed:{}' }, 'and a list of only that one is no list');
});

test('in English the same, and nothing reads Vietnamese or shows a dictionary key', async () => {
  const p = props();
  for (const [label, html] of [
    ['closed', await picker(plain, p, [infoEntry(p, info({ tiers: [{ aboveTokens: 1, rates: { input: 1, output: 1, cacheRead: null, cacheWrite: null } }], status: 'deprecated', contextWindow: 400000, maxInput: 272000 }))], 'en')],
    ['alias', await picker(plain, p, [infoEntry(p, info({ confidence: 'alias', trusted: false }))], 'en')],
    ['open', await picker(opened, { ...p, canListAccount: true }, [infoEntry(p, info()), listEntry(p, LIST)], 'en')],
    ['loading', await picker(opened, p, [], 'en')],
    ['no list', await picker(opened, p, [listEntry(p, { provider: null, source: SOURCE, local: true, total: 0, truncated: false, models: [] })], 'en')],
    ['no match', await picker(filtering, props({ value: 'zzz' }), [listEntry(p, LIST)], 'en')],
    ['save first', await picker(opened, { ...p, canListAccount: false }, [listEntry(p, LIST)], 'en')],
  ]) {
    const root = parseHtml(html);
    assert.doesNotMatch(root.text, DIACRITICS, `${label}: Vietnamese on the English screen`);
    assert.doesNotMatch(html, /ai_model_|ai_catalog_/, `${label}: a dictionary key is shown instead of its text`);
    for (const node of byTag(root, 'button', 'input', 'ul')) for (const attribute of ['aria-label', 'title', 'placeholder']) if (node.attrs[attribute]) assert.doesNotMatch(node.attrs[attribute], DIACRITICS, `${label}: ${attribute}`);
  }
  const english = parseHtml(await picker(plain, p, [infoEntry(p, info())], 'en'));
  assert.equal(textOf(findTestId(english, 'model-facts')), 'Catalog (catalog@2026-10-19): 1M context $2 / $10 per 1M tokens thinks tools reads images');
});

test('every key of the picker is in both languages with the same placeholders, and none of them is a key of the first screen', () => {
  const keys = Object.keys(translations.vi).filter((key) => key.startsWith('ai_model_') || key.startsWith('ai_catalog_'));
  assert.ok(keys.length >= 40, `the picker has its keys: ${keys.length}`);
  const holders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const key of keys) {
    assert.ok(translations.en[key]?.trim(), `en.${key}`);
    assert.deepEqual(holders(translations.en[key]), holders(translations.vi[key]), `${key}: placeholders differ between languages`);
    assert.doesNotMatch(translations.en[key], DIACRITICS, `en.${key} reads Vietnamese`);
  }
});

// ---- the line that names the Hub's list of models, and its update ----

const STATUS = { source: 'bundled', label: SOURCE, generatedAt: '2026-10-19', ageDays: 5, providers: 232, models: 9056, url: 'https://models.dev/api.json', refreshing: false, ignored: null, lastRefresh: null, bundled: { generatedAt: '2026-10-19', models: 9056 } };
const status = (bundle, data, lang = 'vi') => render(bundle, 'CatalogStatusLine', {}, data ? [[['catalogStatus'], data]] : [], lang);

test('the status line names the list, its source and age, how many models it has, what the update contacts and what it sends', async () => {
  const root = parseHtml(await status(plain, STATUS));
  const line = findTestId(root, 'catalog-status');
  assert.ok(line);
  assert.equal(accessibleName(root, line), translations.vi.ai_catalog_title, 'the line is a group with a name');
  assert.equal(textOf(findTestId(root, 'catalog-line')), 'catalog@2026-10-19 · đi kèm Hub · 5 ngày tuổi · 9.056 model');
  assert.ok(root.text.includes(translations.vi.ai_catalog_privacy), 'what the button contacts, and that it sends nothing of the person\'s');
  const update = byTag(root, 'button').find((node) => node.attrs['data-testid'] === 'catalog-update');
  assert.equal(textOf(update), translations.vi.ai_catalog_update);
  assert.equal(update.attrs.disabled, undefined);
  const refreshed = parseHtml(await status(plain, { ...STATUS, source: 'refreshed', label: 'catalog@2026-11-02', ageDays: 0, models: 9100 }));
  assert.equal(textOf(findTestId(refreshed, 'catalog-line')), 'catalog@2026-11-02 · bạn đã cập nhật · hôm nay · 9.100 model');
  assert.ok(textOf(findTestId(parseHtml(await status(plain, { ...STATUS, ageDays: 1 })), 'catalog-line')).includes('1 ngày tuổi'));
  for (const [ageDays, words] of [[0, 'today'], [1, '1 day old'], [5, '5 days old']]) {
    assert.ok(textOf(findTestId(parseHtml(await status(plain, { ...STATUS, ageDays }, 'en')), 'catalog-line')).includes(` · ${words} · `), `${ageDays} days in English`);
  }
  const busy = parseHtml(await status(plain, { ...STATUS, refreshing: true }));
  assert.equal(byTag(busy, 'button').find((node) => node.attrs['data-testid'] === 'catalog-update').attrs.disabled !== undefined, true, 'one update at a time');
  assert.equal(findTestId(parseHtml(await status(plain, undefined)), 'catalog-line'), undefined, 'before the Hub has answered there is no line to read');
  assert.deepEqual([duplicateIds(root), brokenReferences(root), unnamedControls(root)], [[], [], []]);
});

test('the status line says when the Hub did not use a list it found, and when the last update failed', async () => {
  const ignored = parseHtml(await status(plain, { ...STATUS, ignored: { reason: 'damaged', detail: 'x' } }));
  assert.ok(ignored.text.includes('Hub đã bỏ qua danh sách lưu trong thư mục dữ liệu (tệp hỏng) và dùng danh sách đi kèm.'));
  assert.equal(byRole(ignored, 'status').length, 1, 'said to a screen reader too');
  for (const [reason, text] of [['older', 'cũ hơn danh sách đi kèm'], ['future', 'đề ngày trong tương lai'], ['something-new', 'something-new']]) {
    assert.ok(parseHtml(await status(plain, { ...STATUS, ignored: { reason, detail: 'd' } })).text.includes(`(${text})`), reason);
  }
  const failed = parseHtml(await status(plain, { ...STATUS, lastRefresh: { at: '2026-10-24T08:00:00.000Z', ok: false, code: 'catalog_http', error: 'models.dev answered HTTP 503.' } }));
  const alert = byRole(failed, 'alert')[0];
  assert.equal(textOf(alert), 'Chưa cập nhật được danh sách model: models.dev answered HTTP 503. Danh sách đang dùng không đổi.');
  assert.equal(byRole(parseHtml(await status(plain, { ...STATUS, lastRefresh: { at: '2026-10-24T08:00:00.000Z', ok: true } })), 'alert').length, 0, 'a good update leaves no alert');
  const english = parseHtml(await status(plain, { ...STATUS, ignored: { reason: 'older', detail: 'd' }, lastRefresh: { at: 'x', ok: false, code: 'catalog_http', error: 'models.dev answered HTTP 503.' } }, 'en'));
  assert.doesNotMatch(english.text, DIACRITICS);
  assert.ok(english.text.includes('The model list could not be updated: models.dev answered HTTP 503. The list in use is unchanged.'));
  assert.ok(english.text.includes('The Hub ignored the list saved in its data folder (older than the one that ships) and uses the one that ships with it.'));
});

// ---- what the button does ----

const calls = [];
const routes = new Map();
const toasts = [];
const showToast = (message, type) => { toasts.push([message, type]); };
const reply = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (route, options = {}) => {
  calls.push({ route, method: options.method ?? 'GET', body: options.body });
  const answer = routes.get(route);
  const result = answer ? await answer() : { ok: true };
  return result instanceof Response ? result : reply(200, result);
};
const serve = (table = {}) => { calls.length = 0; toasts.length = 0; routes.clear(); for (const [route, answer] of Object.entries(table)) routes.set(route, typeof answer === 'function' ? answer : () => answer); };
async function press(name, p, entries, lang, match) {
  globalThis.__chatmcpJsx = [];
  await clicks.loaded.renderWith(clicks.loaded[name], p, entries, [], { lang, showToast });
  const found = globalThis.__chatmcpJsx.find((element) => match(element) && typeof element.props.onClick === 'function');
  assert.ok(found, 'no such button');
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  try {
    await found.props.onClick();
    for (let turn = 0; turn < 40; turn++) await new Promise((resolve) => setImmediate(resolve));
  } finally { delete globalThis.localStorage; }
  return globalThis.__chatmcpInvalidated.slice();
}
const updateButton = (element) => element.type === 'button' && element.props['data-testid'] === 'catalog-update';

test('the update button asks the Hub for one refresh, refreshes what depends on the list, and says so; a failure leaves the list alone and says why', async () => {
  for (const lang of ['vi', 'en']) {
    const words = translations[lang];
    serve({ '/api/ai/catalog/refresh': { ...STATUS, source: 'refreshed', label: 'catalog@2026-11-02', generatedAt: '2026-11-02', ageDays: 0, models: 9100, lastRefresh: { at: 'x', ok: true } } });
    const invalidated = await press('CatalogStatusLine', {}, [[['catalogStatus'], STATUS]], lang, updateButton);
    assert.deepEqual(calls.map((call) => [call.method, call.route]), [['POST', '/api/ai/catalog/refresh']], `${lang}: one request, a POST`);
    assert.deepEqual(toasts, [[words.ai_catalog_updated.replace('{label}', 'catalog@2026-11-02').replace('{models}', lang === 'vi' ? '9.100' : '9,100'), 'success']], `${lang}: said`);
    const keys = invalidated.map((filter) => filter.queryKey[0]).sort();
    assert.deepEqual(keys, ['catalogModels', 'hubState', 'modelInfo'], `${lang}: what depends on the list is asked again`);
    serve({ '/api/ai/catalog/refresh': () => reply(502, { error: 'models.dev answered HTTP 503.', code: 'catalog_http' }) });
    await press('CatalogStatusLine', {}, [[['catalogStatus'], STATUS]], lang, updateButton);
    assert.deepEqual(toasts, [], `${lang}: a failure is not a success toast`);
    assert.equal(calls.length, 1, `${lang}: and it is not tried again by itself`);
  }
});

// ---- what the field does when it is used ----

async function elementsOf(bundle, name, p, entries, lang = 'vi') {
  globalThis.__chatmcpJsx = [];
  await bundle.loaded.renderWith(bundle.loaded[name], p, entries, [], { lang, showToast });
  return globalThis.__chatmcpJsx.slice();
}
const inputOf = (elements) => elements.find((element) => element.type === 'input' && element.props.role === 'combobox');
const optionOf = (elements, id) => elements.find((element) => element.type === 'li' && element.props.role === 'option' && element.props.id.endsWith('-' + id));

test('typing, choosing and the keyboard hand the value of the field to the form; the models of the account are asked of the Hub only when the button is pressed', async () => {
  const p = props();
  const taken = [];
  const entries = [infoEntry(p, info()), listEntry(p, LIST)];
  // typing is the form's value at once
  let elements = await elementsOf(clicks, 'ModelPicker', { ...p, onChange: (value) => taken.push(value) }, entries);
  inputOf(elements).props.onChange({ target: { value: 'claude-opu' } });
  assert.deepEqual(taken, ['claude-opu']);
  // an option chosen with the mouse
  taken.length = 0;
  elements = await elementsOf(openClicks, 'ModelPicker', { ...p, onChange: (value) => taken.push(value) }, entries);
  optionOf(elements, 1).props.onClick();
  assert.deepEqual(taken, ['claude-sonnet-5-5'], 'the second one of the list, by its place');
  optionOf(elements, 0).props.onClick();
  assert.deepEqual(taken, ['claude-sonnet-5-5', 'claude-opus-5-5']);
  // Enter takes the active one (the first, as the list opens), and only in an open list
  taken.length = 0;
  let prevented = 0;
  inputOf(elements).props.onKeyDown({ key: 'Enter', preventDefault() { prevented += 1; } });
  assert.deepEqual([taken, prevented], [['claude-opus-5-5'], 1]);
  inputOf(elements).props.onKeyDown({ key: 'a', preventDefault() { prevented += 1; } });
  assert.deepEqual([taken.length, prevented], [1, 1], 'a letter is left to the field');
  const closed = await elementsOf(clicks, 'ModelPicker', { ...p, onChange: (value) => taken.push(value) }, entries);
  inputOf(closed).props.onKeyDown({ key: 'Enter', preventDefault() { prevented += 1; } });
  assert.deepEqual([taken.length, prevented], [1, 1], 'Enter in a closed field is left to the page');

  // the account's models: one request, to the Hub, when the button is pressed
  const press = async (buttonLabel) => {
    const elements = await elementsOf(openClicks, 'ModelPicker', { ...p, canListAccount: true }, entries);
    const button = elements.find((element) => element.type === 'button' && typeof element.props.onClick === 'function' && element.props.children === buttonLabel);
    assert.ok(button, 'the button');
    serve({ '/api/ai/models': { models: [{ id: 'claude-opus-5-5', name: 'claude-opus-5-5' }], source: 'provider' } });
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    try { await button.props.onClick(); for (let turn = 0; turn < 40; turn++) await new Promise((resolve) => setImmediate(resolve)); } finally { delete globalThis.localStorage; }
  };
  await press(translations.vi.ai_model_load_account);
  assert.deepEqual(calls.map((call) => [call.method, call.route]), [['GET', '/api/ai/models']], 'nothing was asked of the provider until then');
  await press(translations.vi.ai_model_load_account);
  assert.equal(calls.length, 1, 'and each press is one request');
  // while the list is only opened, the Hub is not asked
  serve();
  await elementsOf(openClicks, 'ModelPicker', { ...p, canListAccount: true }, entries);
  assert.deepEqual(calls.map((call) => call.route), [], 'opening the list asks the provider nothing');
});

// ---- what the picker asks the Hub for ----

/** What the component asks React Query for while it renders (the key and `enabled` of each query): a server render never fetches, but the observer is told what it should. */
async function queriesOf(bundle, name, p, entries) {
  const { QueryObserver } = bundle.loaded;
  const seen = [];
  const original = QueryObserver.prototype.getOptimisticResult;
  QueryObserver.prototype.getOptimisticResult = function (options) { seen.push({ key: options.queryKey, enabled: options.enabled, placeholder: typeof options.placeholderData }); return original.call(this, options); };
  try { await bundle.loaded.renderWith(bundle.loaded[name], p, entries, [], { lang: 'vi' }); } finally { QueryObserver.prototype.getOptimisticResult = original; }
  return seen;
}
const queryNamed = (seen, name) => seen.find((query) => query.key[0] === name);

test('the Hub is asked for the list of a provider only when the list is open and there is something to ask about; the line about the model needs a model and a connection', async () => {
  const p = props();
  assert.equal(queryNamed(await queriesOf(plain, 'ModelPicker', p, []), 'catalogModels').enabled, false, 'closed: nothing is asked of the Hub');
  const asked = queryNamed(await queriesOf(opened, 'ModelPicker', p, []), 'catalogModels');
  assert.deepEqual([asked.enabled, asked.key], [true, ['catalogModels', 'anthropic', 'https://api.anthropic.com']]);
  const custom = queryNamed(await queriesOf(opened, 'ModelPicker', props({ preset: undefined, protocol: 'openai-chat', apiBaseUrl: '  https://gw.example/v1 ' }), []), 'catalogModels');
  assert.deepEqual([custom.enabled, custom.key], [true, ['catalogModels', '', 'https://gw.example/v1']], 'a custom endpoint is asked about with its address, without the spaces around it');
  assert.equal(queryNamed(await queriesOf(opened, 'ModelPicker', props({ preset: undefined, apiBaseUrl: '   ' }), []), 'catalogModels').enabled, false, 'no preset and no address: nothing to ask about');
  const line = async (extra) => queryNamed(await queriesOf(plain, 'ModelPicker', props(extra), []), 'modelInfo');
  const known = await line({});
  assert.deepEqual([known.enabled, known.key], [true, ['modelInfo', 'anthropic', 'anthropic', 'https://api.anthropic.com', 'claude-sonnet-5-5']]);
  assert.equal((await line({ value: '  ' })).enabled, false, 'no model typed: nothing to ask');
  assert.equal((await line({ preset: undefined, protocol: undefined })).enabled, false, 'no preset and no protocol: nothing to ask');
  assert.equal((await line({ preset: undefined, protocol: 'openai-chat' })).enabled, true, 'a protocol without a preset (a model profile) is enough');
  assert.equal((await line({ protocol: undefined })).enabled, true, 'and so is a preset without a protocol');
  // the question is asked only when it can be answered: a model id the Hub would refuse (it answers 400) or half an address is no question, and what was known of the previous model stays while the next answer comes
  assert.equal((await line({ value: 'my model' })).enabled, false, 'a model id with a space');
  assert.equal((await line({ value: 'x'.repeat(152) })).enabled, false, 'or one that is too long');
  for (const half of ['htt', 'https://', 'ftp://gw.example', 'gw.example/v1']) assert.equal((await line({ apiBaseUrl: half })).enabled, false, half + ': not an address');
  assert.equal((await line({ apiBaseUrl: '' })).enabled, true, 'no address is no problem: the preset has its own');
  assert.equal((await line({ apiBaseUrl: '  http://localhost:11434/v1 ' })).enabled, true, 'an address with spaces around it is the address');
  const padded = await line({ value: '  claude-sonnet-5-5 ' });
  assert.deepEqual([padded.enabled, padded.key], [true, known.key], 'a model with spaces around it is the model: the same question as without them');
  assert.equal((await line({})).placeholder, 'function', 'the answer for the previous model stays on the page while the next one comes');
  assert.equal((await line({ value: '  ' })).placeholder, 'undefined', 'but not for a model that was cleared');
});

// ---- what is done to the field ----

const sorted = (log) => log.map((entry) => JSON.stringify(entry)).sort();
const expected = (...log) => sorted(log);
/** The elements a render creates, from a picker whose state starts as `initial` says and logs what is set on globalThis.__picker. */
async function elementsWithState(p, entries, initial = {}) {
  globalThis.__picker = [];
  globalThis.__pickerInitial = initial;
  globalThis.__chatmcpJsx = [];
  await logging.loaded.renderWith(logging.loaded.ModelPicker, p, entries, [], { lang: 'vi', showToast });
  return globalThis.__chatmcpJsx.slice();
}
/** The state a handler sets (no matter in which order). */
const doing = (action) => { globalThis.__picker = []; action(); return sorted(globalThis.__picker); };
const browseOf = (elements) => elements.find((element) => element.type === 'button' && element.props['aria-haspopup'] === 'listbox');
const key = (elements, name) => doing(() => inputOf(elements).props.onKeyDown({ key: name, preventDefault() {} }));

test('what is done to the field changes what it shows: typing opens the list and filters it, a choice closes it, the browse button toggles it, the keys move through it', async () => {
  const p = props();
  const entries = [infoEntry(p, info()), listEntry(p, LIST)];
  const taken = [];
  const withChange = { ...p, onChange: (value) => taken.push(value) };
  const closed = await elementsWithState(withChange, entries);
  const open = await elementsWithState(withChange, entries, { open: true });
  assert.deepEqual(doing(() => inputOf(closed).props.onChange({ target: { value: 'x' } })), expected(['typed', true], ['open', true], ['active', -1]), 'typing filters the list and opens it, with no model active: Enter keeps what was typed');
  assert.deepEqual(taken, ['x'], 'and is the value of the form at once');
  assert.deepEqual(doing(() => optionOf(open, 1).props.onClick()), expected(['open', false], ['typed', false]), 'a choice closes the list and stops the filter');
  assert.deepEqual(doing(() => browseOf(closed).props.onClick()), expected(['open', true], ['typed', false], ['active', 0]), 'the browse button opens the list on all of the models');
  assert.deepEqual(doing(() => browseOf(open).props.onClick()), expected(['open', false], ['typed', false], ['active', 0]), 'and closes it');
  assert.deepEqual(doing(() => inputOf(closed).props.onBlur()), expected(['open', false]), 'leaving the field closes the list');
  assert.deepEqual(doing(() => optionOf(open, 2).props.onMouseEnter()), expected(['active', 2]), 'the mouse makes an option the active one');
  // the keys
  assert.deepEqual(key(closed, 'ArrowDown'), expected(['open', true], ['typed', false], ['active', 0]), 'the arrow opens a closed list, on all of the models');
  assert.deepEqual(key(open, 'ArrowDown'), expected(['active', 1]), 'and moves through an open one');
  assert.deepEqual(key(open, 'Escape'), expected(['open', false]), 'Escape closes it');
  assert.deepEqual([key(closed, 'Escape'), key(closed, 'ArrowUp'), key(open, 'a')], [[], [], []], 'what is not for the list is left to the field and the page');
  const second = await elementsWithState(withChange, entries, { open: true, active: 1 });
  assert.deepEqual(key(second, 'ArrowUp'), expected(['active', 0]), 'the arrow up moves back');
  taken.length = 0;
  assert.deepEqual(key(second, 'Enter'), expected(['open', false], ['typed', false]), 'Enter chooses the active model and closes the list');
  assert.deepEqual(taken, ['claude-sonnet-5-5'], 'the second of the list, not the first');
  // after typing no model is active: Enter keeps what was typed (a model newer than the catalog, which is the start of another one's id, must not become that one), and the first key down goes to the first
  const typedList = await elementsWithState({ ...props({ value: 'claude' }), onChange: (value) => taken.push(value) }, entries, { open: true, typed: true, active: -1 });
  taken.length = 0;
  assert.deepEqual(key(typedList, 'Enter'), [], 'Enter after typing is left to the field');
  assert.deepEqual(taken, [], 'and chooses nothing');
  assert.deepEqual(key(typedList, 'ArrowDown'), expected(['active', 0]), 'the arrow down goes to the first match');
  assert.equal(inputOf(typedList).props['aria-activedescendant'], undefined, 'no option is announced as active until the keys move to one');
  // the list shrinks under an active place (the account's models replace the catalog's, a filter narrows it): the last one is the active one, not none
  const shrunk = await elementsWithState(withChange, entries, { open: true, active: 6 });
  const shownOptions = shrunk.filter((element) => element.type === 'li' && element.props.role === 'option');
  assert.deepEqual(shownOptions.map((element) => /bg-hover/.test(element.props.className)), [false, false, true], 'the last of the three is marked');
  assert.equal(inputOf(shrunk).props['aria-activedescendant'], shownOptions[2].props.id, 'and announced');
  assert.deepEqual(key(shrunk, 'ArrowUp'), expected(['active', 1]), 'the arrow up moves from it');
  taken.length = 0;
  key(shrunk, 'Enter');
  assert.deepEqual(taken, ['claude-haiku-3'], 'and Enter takes it');
  // a press on the browse button does not take the focus (see below), so the button gives it to the field: the arrows, Enter and Escape then act on the list it opened
  const focused = [];
  inputOf(closed).props.ref.current = { focus: () => focused.push('focus') };
  browseOf(closed).props.onClick();
  assert.deepEqual(focused, ['focus'], 'the field has the focus');
  // a key that belongs to an input method (a word still being composed, as with Telex) is not for the list: the Enter that ends a composition must not choose a model
  taken.length = 0;
  const left = [];
  const viaMethod = (event) => doing(() => inputOf(second).props.onKeyDown({ preventDefault() { left.push(event.key); }, ...event }));
  assert.deepEqual(viaMethod({ key: 'Enter', nativeEvent: { isComposing: true } }), [], 'Enter while a word is being composed');
  assert.deepEqual(viaMethod({ key: 'Enter', keyCode: 229 }), [], 'and the Enter that Safari sends after the composition ended (key code 229)');
  assert.deepEqual(viaMethod({ key: 'ArrowDown', nativeEvent: { isComposing: true } }), [], 'an arrow that moves the choice of the input method');
  assert.deepEqual([taken, left], [[], []], 'nothing was chosen, and the key was left to the input method');
  const many = { ...LIST, total: 300, models: Array.from({ length: 120 }, (_, index) => model(`m-${String(index).padStart(3, '0')}`)) };
  const long = await elementsWithState(p, [listEntry(p, many)], { open: true, active: 49 });
  assert.deepEqual(key(long, 'ArrowDown'), expected(['active', 49]), 'the last model that is shown is the last one there is, not the 120th');
  // a list that typing opened and that has nothing to offer is not on the page: the button and the arrow show the whole list, and Escape has nothing to close
  const hidden = await elementsWithState({ ...props({ value: 'zzz' }), onChange: (value) => taken.push(value) }, entries, { open: true, typed: true });
  assert.deepEqual(doing(() => browseOf(hidden).props.onClick()), expected(['open', true], ['typed', false], ['active', 0]), 'the browse button shows the whole list');
  assert.deepEqual(key(hidden, 'ArrowDown'), expected(['open', true], ['typed', false], ['active', 0]), 'and so does the arrow');
  assert.deepEqual(key(hidden, 'Escape'), [], 'there is nothing to close');
  // a press on the button or inside the list must not take the focus from the field: the list would close before the press is a click
  const prevented = [];
  for (const target of [browseOf(closed), open.find((element) => element.type === 'div' && typeof element.props.onMouseDown === 'function')]) {
    assert.ok(target, 'a handler');
    target.props.onMouseDown({ preventDefault() { prevented.push(target.type); } });
  }
  assert.deepEqual(prevented, ['button', 'div']);
});

test('the account\'s own models: what each answer of the Hub leaves in the field, and one request at a time', async () => {
  const t = translations.vi;
  const p = props({ canListAccount: true });
  const entries = [infoEntry(p, info()), listEntry(p, LIST)];
  const loaded = { models: [{ id: 'claude-opus-5-5', name: 'claude-opus-5-5' }], source: 'provider' };
  async function pressAccount(table, initial = {}) {
    serve(table);
    const elements = await elementsWithState(p, entries, { open: true, ...initial });
    const button = elements.find((element) => element.type === 'button' && typeof element.props.onClick === 'function' && element.props.children === t.ai_model_load_account);
    assert.ok(button, 'the button');
    globalThis.__picker = [];
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    try { await button.props.onClick(); for (let turn = 0; turn < 40; turn++) await new Promise((resolve) => setImmediate(resolve)); } finally { delete globalThis.localStorage; }
    return { log: globalThis.__picker.slice(), calls: calls.map((call) => call.route) };
  }
  assert.deepEqual(await pressAccount({ '/api/ai/models': loaded }), { log: [['account', { for: CONNECTION, busy: true }], ['account', { for: CONNECTION, models: loaded.models, message: t.ai_model_account_loaded.replace('{n}', '1') }]], calls: ['/api/ai/models'] }, 'the provider answered: its models are the list');
  const refused = await pressAccount({ '/api/ai/models': { models: [{ id: 'claude-opus-5-5', name: 'x' }], source: 'configured', warning: 'Nhập API key để tải danh sách model.' } });
  assert.deepEqual(refused.log.at(-1), ['account', { for: CONNECTION, message: 'Nhập API key để tải danh sách model.' }], 'the Hub could not ask the provider: its warning, and no list (the configured model alone is not one)');
  assert.deepEqual((await pressAccount({ '/api/ai/models': { models: [], source: 'provider' } })).log.at(-1), ['account', { for: CONNECTION, message: t.ai_model_account_failed }], 'an empty answer: our words');
  assert.deepEqual((await pressAccount({ '/api/ai/models': () => reply(500, { error: 'boom' }) })).log.at(-1), ['account', { for: CONNECTION, message: `${t.ai_model_account_failed} boom` }], 'a request that fails says why');
  assert.deepEqual(await pressAccount({ '/api/ai/models': loaded }, { account: { for: CONNECTION, busy: true } }), { log: [], calls: [] }, 'one request at a time: while one is out, pressing again asks nothing');

  // what the field shows of it
  async function shown(initial, more = {}) {
    globalThis.__picker = [];
    globalThis.__pickerInitial = { open: true, ...initial };
    return parseHtml(await logging.loaded.renderWith(logging.loaded.ModelPicker, { ...p, ...more }, entries, [], { lang: 'vi' }));
  }
  const accountButton = (root) => byTag(root, 'button').find((node) => textOf(node) === t.ai_model_load_account);
  assert.equal(accountButton(await shown({ account: { for: CONNECTION, busy: true } })).attrs.disabled !== undefined, true, 'disabled while a request is out');
  assert.equal(accountButton(await shown({})).attrs.disabled, undefined);
  const warned = await shown({ account: { for: CONNECTION, message: 'WARNING' } });
  assert.equal(textOf(byRole(warned, 'status')[0]), 'WARNING', 'what went wrong is said next to the button');
  const listed = await shown({ account: { for: CONNECTION, models: [{ id: 'claude-opus-5-5', name: 'claude-opus-5-5' }, { id: 'brand-new-model', name: 'brand-new-model' }], message: 'MESSAGE' } });
  assert.deepEqual(byRole(listed, 'option').map(textOf), ['brand-new-model trong tài khoản', 'claude-opus-5-5 1M ngữ cảnh $5 / $25 mỗi 1M token suy luận công cụ đọc ảnh trong tài khoản'], 'the account\'s models with what the catalog knows of them; one it does not know has nothing else to say');
  assert.equal(textOf(findTestId(listed, 'model-list-note')), 'MESSAGE', 'and the note says what was loaded');
  assert.equal(byRole(listed, 'status').length, 0, 'no warning beside a list that was loaded');
  const withDeployment = await shown({ account: { for: CONNECTION, models: [{ id: 'claude-opus-5-5', name: 'claude-opus-5-5' }, { id: 'my-deployment', name: 'my-deployment', configured: true, listed: false }], message: 'MESSAGE' } });
  assert.deepEqual(byRole(withDeployment, 'option').map(textOf), ['claude-opus-5-5 1M ngữ cảnh $5 / $25 mỗi 1M token suy luận công cụ đọc ảnh trong tài khoản', 'my-deployment'], 'the model that is configured and that the provider did not list is there, and is not said to be in the account');

  // what was asked for one connection belongs to it: after another provider is chosen in the form (or another address typed) the list is that provider's, with no trace of the answer, the
  // warning or the request that is still out for the other one
  const OTHER = 'openai|https://api.openai.com/v1|0';
  const elsewhere = await shown({ account: { for: OTHER, models: [{ id: 'brand-new-model', name: 'brand-new-model' }], message: 'MESSAGE', busy: true } });
  assert.deepEqual(byRole(elsewhere, 'option').map(textOf).map((text) => text.split(' ')[0]), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-3'], 'the catalog\'s list of this provider, not the account of the other one');
  assert.ok(!elsewhere.text.includes(t.ai_model_badge_account), 'nothing is said to be in the account');
  assert.equal(textOf(findTestId(elsewhere, 'model-list-note')), `Danh sách: ${SOURCE}`, 'and the note is the list\'s');
  assert.equal(accountButton(elsewhere).attrs.disabled, undefined, 'a request that is out for the other connection does not keep this one waiting');
  const warnedElsewhere = await shown({ account: { for: OTHER, message: 'WARNING' } });
  assert.equal(byRole(warnedElsewhere, 'status').length, 0, 'the warning of the other connection is not shown');
  assert.deepEqual(await pressAccount({ '/api/ai/models': loaded }, { account: { for: OTHER, busy: true } }).then((result) => result.calls), ['/api/ai/models'], 'and it can be asked for');
  // saving the form again makes the connection another one (a new key for the same address is another account): what was asked before the save is gone, what is asked after it is kept
  const afterSave = await shown({ account: { for: 'anthropic|https://api.anthropic.com|7', models: [{ id: 'brand-new-model', name: 'brand-new-model' }], message: 'MESSAGE' } }, { accountRevision: 7 });
  assert.deepEqual(byRole(afterSave, 'option').map(textOf), ['brand-new-model trong tài khoản'], 'asked after the seventh save: kept');
  const beforeSave = await shown({ account: { for: CONNECTION, models: [{ id: 'brand-new-model', name: 'brand-new-model' }], message: 'MESSAGE' } }, { accountRevision: 7 });
  assert.ok(!beforeSave.text.includes(t.ai_model_badge_account), 'asked before it: not shown');
  // a connection is the preset AND the address: the same preset at another address, and another preset at the same address, are other connections
  for (const [label, other] of [['the same provider at another address', 'anthropic|https://gateway.example/v1|0'], ['another provider at this address', 'openai|https://api.anthropic.com|0'], ['the same connection before the form was saved again', 'anthropic|https://api.anthropic.com|7']]) {
    const page = await shown({ account: { for: other, models: [{ id: 'brand-new-model', name: 'brand-new-model' }], message: 'MESSAGE' } });
    assert.ok(!page.text.includes(t.ai_model_badge_account) && textOf(findTestId(page, 'model-list-note')) === `Danh sách: ${SOURCE}`, `${label}: what was asked for the other one is not shown`);
  }
  // the busy mark and the answers of another connection do not leak into a request for this one
  const stale = await pressAccount({ '/api/ai/models': loaded }, { account: { for: OTHER, models: [{ id: 'old', name: 'old' }], message: 'OLD' } });
  assert.deepEqual(stale.log[0], ['account', { for: CONNECTION, busy: true }], 'a new request starts from nothing, not from the other connection\'s answer');
});

// ---- the update button, in the states a click leads to ----

test('the update button: one request at a time, a good answer replaces the line at once, a failure is kept in the line and writes nothing', async () => {
  const t = translations.vi;
  const refreshed = { ...STATUS, source: 'refreshed', label: 'catalog@2026-11-02', models: 9100, lastRefresh: { at: 'x', ok: true } };
  async function pressUpdate(table, initial = {}) {
    serve(table);
    globalThis.__status = [];
    globalThis.__statusInitial = initial;
    globalThis.__chatmcpJsx = [];
    await logging.loaded.renderWith(logging.loaded.CatalogStatusLine, {}, [[['catalogStatus'], STATUS]], [], { lang: 'vi', showToast });
    const button = globalThis.__chatmcpJsx.find((element) => updateButton(element) && typeof element.props.onClick === 'function');
    assert.ok(button, 'the button');
    globalThis.__status = [];
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    try { await button.props.onClick(); for (let turn = 0; turn < 40; turn++) await new Promise((resolve) => setImmediate(resolve)); } finally { delete globalThis.localStorage; }
    return { log: globalThis.__status.slice(), calls: calls.map((call) => call.route), stored: globalThis.__chatmcpClient.getQueryData(['catalogStatus']) };
  }
  const good = await pressUpdate({ '/api/ai/catalog/refresh': refreshed });
  assert.deepEqual(good.log, [['busy', true], ['problem', ''], ['busy', false]], 'busy while the request is out, and the old problem is forgotten');
  assert.deepEqual(good.stored, refreshed, 'the new status is the line at once');
  const bad = await pressUpdate({ '/api/ai/catalog/refresh': () => reply(502, { error: 'models.dev answered HTTP 503.', code: 'catalog_http' }) });
  assert.deepEqual(bad.log, [['busy', true], ['problem', ''], ['problem', t.ai_catalog_failed.replace('{error}', 'models.dev answered HTTP 503.')], ['busy', false]], 'the failure is kept in the line, and the button is free again');
  assert.equal(bad.stored, undefined, 'and nothing is written into the status');
  assert.deepEqual(await pressUpdate({ '/api/ai/catalog/refresh': refreshed }, { busy: true }).then((result) => [result.log, result.calls]), [[], []], 'one update at a time: while one is out, pressing again asks nothing');

  async function shown(initial, data = STATUS) {
    globalThis.__statusInitial = initial;
    return parseHtml(await logging.loaded.renderWith(logging.loaded.CatalogStatusLine, {}, [[['catalogStatus'], data]], [], { lang: 'vi' }));
  }
  const buttonOf = (root) => byTag(root, 'button').find((node) => node.attrs['data-testid'] === 'catalog-update');
  const working = buttonOf(await shown({ busy: true }));
  assert.deepEqual([textOf(working), working.attrs.disabled !== undefined], [t.ai_catalog_updating, true], 'while it works the button says so and cannot be pressed');
  const updating = buttonOf(await shown({}, { ...STATUS, refreshing: true }));
  assert.deepEqual([textOf(updating), updating.attrs.disabled !== undefined], [t.ai_catalog_updating, true], 'the same when the Hub reports an update under way');
  assert.equal(textOf(byRole(await shown({ problem: 'PROBLEM' }), 'alert')[0]), 'PROBLEM', 'what the press just now ended with is told');
  const both = await shown({ problem: 'PROBLEM' }, { ...STATUS, lastRefresh: { at: 'x', ok: false, error: 'OLD' } });
  assert.deepEqual(byRole(both, 'alert').map(textOf), ['PROBLEM'], 'and comes before the failure the Hub remembers, which is one alert, not two');
});

// ---- the field and its script ----

test('the field is the plain input until the picker\'s script is there, then the picker with everything the form gave it', async () => {
  const fresh = await bundleTsx(entry, 'chatmcp-picker-field-', { recordJsx: true });
  try {
    const taken = [];
    const p = props({ onChange: (value) => taken.push(value), canListAccount: true, showCatalog: true });
    const entries = [infoEntry(p, info()), listEntry(p, LIST), [['catalogStatus'], STATUS]];
    globalThis.__chatmcpJsx = [];
    const before = parseHtml(await fresh.loaded.renderWith(fresh.loaded.ModelField, p, entries, [], { lang: 'vi' }));
    const elements = globalThis.__chatmcpJsx.slice();
    assert.equal(byRole(before, 'combobox').length, 0, 'the script is not here yet: the plain input');
    elements.find((element) => element.type === 'input').props.onChange({ target: { value: 'typed' } });
    assert.deepEqual(taken, ['typed'], 'typing in it is typing in the form');
    assert.equal(elements.find((element) => element.type === fresh.loaded.PickerBoundary).props.fallback.type, 'input', 'and the same input stands in when the script cannot be had');
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
    const after = parseHtml(await fresh.loaded.renderWith(fresh.loaded.ModelField, p, entries, [], { lang: 'vi' }));
    const [input] = byRole(after, 'combobox');
    assert.deepEqual([input.attrs.id, input.attrs['aria-label'], input.attrs.value, input.attrs.placeholder, input.attrs.class], ['m', 'Model', 'claude-sonnet-5-5', 'model id', 'w-full min-w-0 flex-1'], 'the script is here: the picker, on the same input');
    assert.ok(findTestId(after, 'model-facts'), 'the preset and the protocol reached it: the line about the model');
    assert.ok(findTestId(after, 'catalog-status'), 'and the wish to name the Hub\'s list of models');
    const quiet = parseHtml(await fresh.loaded.renderWith(fresh.loaded.ModelField, { ...p, showCatalog: false }, entries, [], { lang: 'vi' }));
    assert.equal(findTestId(quiet, 'catalog-status'), undefined, 'a field that does not ask for it does not name the Hub\'s list');
  } finally { await fresh.dispose(); }
});
