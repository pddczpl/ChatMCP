import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';
import { parseHtml, byTag, accessibleName, visibleWords } from './support/html.mjs';

// The "Thinking effort" field of the AI settings (the AI connection and the model profiles): Auto, or the levels the Hub says the model takes, with a note that says where the
// list comes from, that it is a guess, or why there is nothing to choose. These tests pin the rules (a level is never offered that the Hub would not send, and the level that is
// set is never hidden behind Auto) and the words, in both languages. What the click does to the request is tested with the AI form (settings-screens.test.mjs).
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { ReasoningEffortField } from './src/components/inspector/ReasoningEffortField';
  import { modelInfoKey, reasoningChoices, reasoningHint, reasoningLabelKey } from './src/lib/reasoning-effort';
  import { translations } from './src/lib/i18n';
  export { ReasoningEffortField, modelInfoKey, reasoningChoices, reasoningHint, reasoningLabelKey, translations };
`, 'chatmcp-reasoning-field-');
after(dispose);
const { renderWith, ReasoningEffortField, modelInfoKey, reasoningChoices, reasoningHint, reasoningLabelKey, translations } = loaded;

const DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const info = (levels, reasoning = {}, rest = {}) => ({
  model: 'm', protocol: 'anthropic', preset: 'anthropic', found: true, confidence: 'exact', source: 'catalog@2026-10-19', provider: 'anthropic', local: false,
  contextWindow: 1000000, maxOutput: 128000, toolCall: true, vision: true,
  reasoning: { supported: true, toggle: false, budget: null, efforts: levels, levels, known: true, why: null, ...reasoning },
  catalog: { generatedAt: '2026-10-19', ageDays: 5 },
  ...rest,
});
const CLAUDE = info(['low', 'medium', 'high', 'xhigh', 'max']);
const NONE_TO_HIGH = info(['none', 'low', 'medium', 'high']);
const GUESS = info(['low', 'medium', 'high'], { known: false });
const NOTHING = info([], { supported: false, why: 'model_does_not_reason' });
// A Gemini 2.5 model: no levels of its own, a token budget that the levels are mapped onto.
const BUDGETED = info(['minimal', 'low', 'medium', 'high', 'max'], { efforts: [], budget: { min: 128, max: 32768 } }, { protocol: 'gemini', preset: 'gemini', provider: 'google' });

test('the select offers Auto, then the levels of the model, and shows the level that is set even when the model does not list it', () => {
  assert.deepEqual(reasoningChoices(CLAUDE, 'auto'), [{ value: 'auto', offered: true }, ...['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, offered: true }))]);
  assert.deepEqual(reasoningChoices(CLAUDE, 'high').map((choice) => choice.value), ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], 'a level that is offered appears once');
  assert.deepEqual(reasoningChoices(NONE_TO_HIGH, 'xhigh').at(-1), { value: 'xhigh', offered: false }, 'the saved level the model does not list is kept, and marked');
  assert.deepEqual(reasoningChoices(undefined, 'high'), [{ value: 'auto', offered: true }, { value: 'high', offered: true }], 'while the Hub has not answered, the saved level is shown as it is');
  assert.deepEqual(reasoningChoices(undefined, 'auto'), [{ value: 'auto', offered: true }]);
  assert.deepEqual(reasoningChoices(NOTHING, 'auto'), [{ value: 'auto', offered: true }], 'nothing to choose');
});

test('the note: where the list comes from, that it is a guess, why there is nothing, that the saved level is not offered, that the provider refused it', () => {
  assert.deepEqual(reasoningHint(CLAUDE, 'auto', false), { key: 'ai_reasoning_hint_known', tone: 'muted', params: { date: '2026-10-19' } });
  assert.deepEqual(reasoningHint(GUESS, 'auto', false), { key: 'ai_reasoning_hint_unknown', tone: 'muted' });
  for (const why of ['model_does_not_reason', 'no_effort_control', 'protocol_not_supported']) {
    assert.deepEqual(reasoningHint(info([], { why }), 'auto', false), { key: `ai_reasoning_why_${why}`, tone: 'muted' }, why);
  }
  assert.deepEqual(reasoningHint(BUDGETED, 'auto', false), { key: 'ai_reasoning_hint_budget', tone: 'muted', params: { max: '32,768' } }, 'a model driven by a budget says that the levels are budgets, and the largest one');
  assert.deepEqual(reasoningHint(BUDGETED, 'none', false), { key: 'ai_reasoning_hint_not_offered', tone: 'warning' }, 'a saved level the model does not take comes before that');
  assert.deepEqual(reasoningHint(info(['low'], { budget: { min: 0, max: 1000 } }), 'auto', false), { key: 'ai_reasoning_hint_known', tone: 'muted', params: { date: '2026-10-19' } }, 'a model with levels of its own is not described as budgeted');
  assert.deepEqual(reasoningHint(NONE_TO_HIGH, 'xhigh', false), { key: 'ai_reasoning_hint_not_offered', tone: 'warning' });
  assert.deepEqual(reasoningHint(CLAUDE, 'high', true), { key: 'ai_reasoning_hint_refused', tone: 'warning' }, 'a refusal comes before everything else');
  assert.equal(reasoningHint(undefined, 'auto', false), null, 'no answer, no note');
  assert.equal(reasoningLabelKey('auto'), 'ai_reasoning_auto');
  assert.equal(reasoningLabelKey('xhigh'), 'ai_reasoning_level_xhigh');
  assert.deepEqual(modelInfoKey('anthropic', 'anthropic', ' https://x.test ', ' m '), ['modelInfo', 'anthropic', 'anthropic', 'https://x.test', 'm']);
});

const render = (lang, { data, props = {} } = {}) => {
  const base = { id: 'f', preset: 'anthropic', protocol: 'anthropic', apiBaseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', value: 'auto', onChange() {}, ...props };
  const entries = data ? [[modelInfoKey(base.preset, base.protocol, base.apiBaseUrl, base.model), data]] : [];
  return renderWith(ReasoningEffortField, base, entries, [], { lang });
};
const field = (html) => {
  const root = parseHtml(html);
  const [select] = byTag(root, 'select');
  const hint = byTag(root, 'p').find((node) => node.attrs['data-testid'] === 'reasoning-hint');
  return { name: accessibleName(root, select), options: byTag(root, 'option').map((node) => ({ value: node.attrs.value, text: node.text, selected: 'selected' in node.attrs })), hint: hint?.text ?? null, words: visibleWords(html) };
};

test('in Vietnamese the field names itself, offers Auto and the levels, and says where the list comes from', async () => {
  const words = translations.vi;
  const shown = field(await render('vi', { data: CLAUDE }));
  assert.equal(shown.name, words.ai_reasoning_label);
  assert.deepEqual(shown.options.map((option) => option.text), [words.ai_reasoning_auto, ...['low', 'medium', 'high', 'xhigh', 'max'].map((level) => words[`ai_reasoning_level_${level}`])]);
  assert.deepEqual(shown.options.map((option) => option.value), ['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(shown.hint, words.ai_reasoning_hint_known.replace('{date}', '2026-10-19'));
  assert.deepEqual(shown.options.filter((option) => option.selected).map((option) => option.value), ['auto'], 'Auto is the one chosen');
  // the level that is set is the one chosen
  assert.deepEqual(field(await render('vi', { data: CLAUDE, props: { value: 'high' } })).options.filter((option) => option.selected).map((option) => option.value), ['high']);
  assert.deepEqual(field(await render('vi', { data: NONE_TO_HIGH, props: { value: 'xhigh' } })).options.filter((option) => option.selected).map((option) => option.value), ['xhigh'], 'even a level the model does not list');
  const budget = field(await render('vi', { data: BUDGETED, props: { preset: 'gemini', protocol: 'gemini', apiBaseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-pro' } }));
  assert.equal(budget.hint, words.ai_reasoning_hint_budget.replace('{max}', '32,768'), 'a model driven by a budget says so');
  assert.ok(!/Gemini/.test(words.ai_reasoning_why_protocol_not_supported), 'the note for a connection type with no levels no longer blames Gemini, which has them now');
});

test('in English the same, and nothing on the English screen reads Vietnamese', async () => {
  const words = translations.en;
  for (const [label, html] of [
    ['levels', await render('en', { data: CLAUDE })],
    ['a level the model does not list', await render('en', { data: NONE_TO_HIGH, props: { value: 'xhigh' } })],
    ['unknown model', await render('en', { data: GUESS })],
    ['nothing to choose', await render('en', { data: NOTHING })],
    ['a budget model', await render('en', { data: BUDGETED, props: { preset: 'gemini', protocol: 'gemini', apiBaseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-pro' } })],
    ['refused', await render('en', { data: CLAUDE, props: { value: 'high', refused: true } })],
    ['no answer yet', await render('en')],
  ]) {
    const shown = field(html);
    assert.equal(shown.name, words.ai_reasoning_label, label);
    const vietnamese = shown.words.filter((word) => DIACRITICS.test(word));
    assert.deepEqual(vietnamese, [], `${label}: no Vietnamese on the English screen`);
    assert.ok(!/ai_reasoning_/.test(html), `${label}: no dictionary key is shown instead of its text`);
  }
  const notOffered = field(await render('en', { data: NONE_TO_HIGH, props: { value: 'xhigh' } }));
  assert.equal(notOffered.options.at(-1).text, words.ai_reasoning_not_offered.replace('{level}', words.ai_reasoning_level_xhigh));
  assert.equal(notOffered.hint, words.ai_reasoning_hint_not_offered);
  const budget = field(await render('en', { data: BUDGETED, props: { preset: 'gemini', protocol: 'gemini', apiBaseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-pro' } }));
  assert.deepEqual(budget.options.map((option) => option.value), ['auto', 'minimal', 'low', 'medium', 'high', 'max'], 'the ladder of a budget model');
  assert.equal(budget.hint, words.ai_reasoning_hint_budget.replace('{max}', '32,768'));
  assert.match(budget.hint, /32,768/, 'the largest budget is in the note');
  const none = field(await render('en', { data: NOTHING }));
  assert.deepEqual(none.options.map((option) => option.text), [words.ai_reasoning_auto]);
  assert.equal(none.hint, words.ai_reasoning_why_model_does_not_reason);
  const refused = await render('en', { data: CLAUDE, props: { value: 'high', refused: true } });
  assert.match(refused, /text-warning/, 'the refusal is a warning');
  assert.equal(field(refused).hint, words.ai_reasoning_hint_refused);
  const loading = field(await render('en'));
  assert.deepEqual(loading.options.map((option) => option.text), [words.ai_reasoning_auto]);
  assert.equal(loading.hint, null);
});

test('every key of the field is in both languages, and a level the Hub may send has a name in both', () => {
  const keys = Object.keys(translations.vi).filter((key) => key.startsWith('ai_reasoning_'));
  assert.ok(keys.length >= 17, `the field has its keys: ${keys.length}`);
  assert.deepEqual(Object.keys(translations.en).filter((key) => key.startsWith('ai_reasoning_')).sort(), keys.sort(), 'the same keys in English');
  for (const level of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.ok(translations.vi[reasoningLabelKey(level)] && translations.en[reasoningLabelKey(level)], level);
  }
  for (const why of ['model_does_not_reason', 'no_effort_control', 'protocol_not_supported']) {
    assert.ok(translations.vi[`ai_reasoning_why_${why}`] && translations.en[`ai_reasoning_why_${why}`], why);
  }
});
