import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';
import { parseHtml, byTag, accessibleName } from './support/html.mjs';

// The thinking effort of ONE task, chosen in the composer: a chip beside the model profile for a new conversation (and for a follow-up), with "Default (what is in force)", Auto,
// and the levels the Hub says the model of that task takes. These tests pin which connection the chip asks about (the global one, the profile chosen, the profile a conversation
// began with), what it offers, when it is not there at all, and the words in both languages.
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { TaskReasoningPicker } from './src/components/conversation/ModelProfilePicker';
  import { taskConnection } from './src/lib/task-reasoning';
  import { modelInfoKey } from './src/lib/reasoning-effort';
  import { translations } from './src/lib/i18n';
  export { TaskReasoningPicker, taskConnection, modelInfoKey, translations };
`, 'chatmcp-task-reasoning-ui-');
after(dispose);
const { renderWith, TaskReasoningPicker, taskConnection, modelInfoKey, translations } = loaded;

const DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const noop = () => {};
const info = (levels, reasoning = {}) => ({
  model: 'm', protocol: 'anthropic', preset: 'anthropic', found: true, confidence: 'exact', source: 'catalog@2026-10-19', provider: 'anthropic', local: false,
  contextWindow: 1000000, maxOutput: 128000, toolCall: true, vision: true,
  reasoning: { supported: true, toggle: false, budget: null, efforts: levels, levels, known: true, why: null, ...reasoning },
  catalog: { generatedAt: '2026-10-19', ageDays: 5 },
});
const CLAUDE = info(['low', 'medium', 'high', 'xhigh', 'max']);
const NOTHING = info([], { supported: false, why: 'model_does_not_reason' });
const GLOBAL = { configured: true, preset: 'anthropic', protocol: 'anthropic', apiBaseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', reasoningEffort: 'medium' };
const FAST = { id: 'fast', name: 'Fast', model: 'gpt-5.6-terra', protocol: 'openai-chat', apiBaseUrl: 'https://api.openai.com/v1', reasoningEffort: 'high' };
const SLOW = { id: 'slow', name: 'Slow', model: 'claude-opus-5-5', protocol: 'anthropic', apiBaseUrl: 'https://api.anthropic.com', reasoningEffort: 'auto' };
const hub = (extra = {}) => ({ ai: { ...GLOBAL, profiles: [FAST, SLOW], ...extra } });

test('the chip asks about the connection the task will be served by: the global one, the default profile, the profile chosen, the profile a conversation began with', () => {
  const global = { preset: 'anthropic', protocol: 'anthropic', apiBaseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', saved: 'medium' };
  assert.deepEqual(taskConnection({ ai: { ...GLOBAL, profiles: [] } }, '', null), global, 'no profile: the global connection and its level');
  assert.deepEqual(taskConnection({ ai: { ...GLOBAL } }, '', null), global, 'no list of profiles at all');
  assert.deepEqual(taskConnection(hub({ defaultProfileId: 'fast' }), '', null), { protocol: 'openai-chat', apiBaseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-terra', saved: 'high' }, 'the default profile, which has no preset');
  assert.deepEqual(taskConnection(hub({ defaultProfileId: 'fast' }), '__global__', null), global, 'the global connection when it is chosen outright');
  assert.deepEqual(taskConnection(hub(), 'slow', null), { protocol: 'anthropic', apiBaseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', saved: 'auto' }, 'the profile chosen');
  assert.equal(taskConnection(hub(), 'gone', null), null, 'a profile that no longer exists: nothing to ask about');
  assert.equal(taskConnection({}, '', null), null, 'no connection at all');
  // a conversation that exists: the profile it began with (by what the Hub kept of it), and its own level when it has one
  const began = { effectiveProfile: { id: 'slow', name: 'Slow', model: 'claude-opus-5-5', protocol: 'anthropic', endpointOrigin: 'https://api.anthropic.com' }, reasoningEffort: null };
  assert.deepEqual(taskConnection(hub(), undefined, began), { protocol: 'anthropic', apiBaseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', saved: 'auto' });
  assert.equal(taskConnection(hub(), undefined, { ...began, reasoningEffort: 'low' }).saved, 'low', 'the level of the conversation wins over the profile\'s');
  const removed = { effectiveProfile: { id: 'deleted', name: 'Old', model: 'old-model', protocol: 'openai-chat', endpointOrigin: 'https://old.example' }, reasoningEffort: 'high' };
  assert.deepEqual(taskConnection(hub(), undefined, removed), { protocol: 'openai-chat', apiBaseUrl: 'https://old.example', model: 'old-model', saved: 'high' }, 'a profile that was deleted since: what the Hub kept of it');
  assert.deepEqual(taskConnection(hub(), undefined, { effectiveProfile: null, reasoningEffort: null }), global, 'a conversation on the global connection');
});

const SELECT = 'select';
const fieldOf = (html) => {
  const root = parseHtml(html);
  const [select] = byTag(root, SELECT);
  if (!select) return null;
  return { name: accessibleName(root, select), options: byTag(root, 'option').map((node) => ({ value: node.attrs.value, text: node.text, selected: 'selected' in node.attrs })), html };
};
const render = (lang, props, data) => {
  const connection = taskConnection(props.hub, props.profileId, props.task ?? null);
  const entries = data && connection ? [[modelInfoKey(connection.preset, connection.protocol, connection.apiBaseUrl, connection.model), data]] : [];
  return renderWith(TaskReasoningPicker, { task: null, value: '', onChange: noop, ...props }, entries, [], { lang });
};
const levelName = (words, level) => (level === 'auto' ? words.agents_tr_auto : words[`ai_reasoning_level_${level}`]);

test('the chip offers "default", Auto and the levels of the model, in Vietnamese and in English', async () => {
  for (const lang of ['vi', 'en']) {
    const words = translations[lang];
    const shown = fieldOf(await render(lang, { hub: hub(), profileId: '' }, CLAUDE));
    assert.equal(shown.name, words.agents_tr_select_label, `${lang}: the select is named`);
    assert.deepEqual(shown.options.map((option) => option.value), ['', 'auto', 'low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(shown.options.map((option) => option.text), [words.agents_tr_default.replace('{level}', levelName(words, 'medium')), levelName(words, 'auto'), ...['low', 'medium', 'high', 'xhigh', 'max'].map((level) => levelName(words, level))]);
    assert.deepEqual(shown.options.filter((option) => option.selected).map((option) => option.value), [''], 'nothing chosen: the default is the one shown');
    assert.ok(shown.html.includes('data-testid="new-task-reasoning"'));
    if (lang === 'en') {
      assert.doesNotMatch(shown.html, DIACRITICS, 'the English chip reads English');
      assert.ok(!/agents_tr_|ai_reasoning_/.test(shown.html), 'and prints no key');
    }
  }
  assert.equal(translations.vi.agents_tr_default.replace('{level}', 'Vừa'), 'Mặc định (Vừa)');
  assert.equal(translations.en.agents_tr_default.replace('{level}', 'Medium'), 'Default (Medium)');
});

test('the level chosen is the one shown; a level the model does not list is kept and marked; with auto saved the default says Auto', async () => {
  const chosen = fieldOf(await render('en', { hub: hub(), profileId: '', value: 'high' }, CLAUDE));
  assert.deepEqual(chosen.options.filter((option) => option.selected).map((option) => option.value), ['high']);
  const odd = fieldOf(await render('en', { hub: hub(), profileId: '', value: 'minimal' }, CLAUDE));
  assert.deepEqual(odd.options.at(-1), { value: 'minimal', text: translations.en.ai_reasoning_not_offered.replace('{level}', translations.en.ai_reasoning_level_minimal), selected: true }, 'kept, marked, and selected');
  const auto = fieldOf(await render('en', { hub: hub(), profileId: 'slow' }, info(['low', 'medium', 'high'])));
  assert.equal(auto.options[0].text, 'Default (Auto)', 'a profile on auto: the default says Auto');
  // before the Hub has answered about the model: the default and Auto only
  const waiting = fieldOf(await render('en', { hub: hub(), profileId: '' }, null));
  assert.deepEqual(waiting.options.map((option) => option.value), ['', 'auto']);
});

test('the chip is not there when the model does not think, when there is no connection, and a follow-up shows what the conversation has', async () => {
  assert.equal(fieldOf(await render('en', { hub: hub(), profileId: '' }, NOTHING)), null, 'a model that does not think: nothing to choose');
  assert.equal(fieldOf(await render('en', { hub: hub(), profileId: 'gone' }, CLAUDE)), null, 'a profile that is gone: nothing to ask about');
  assert.equal(fieldOf(await render('en', { hub: {}, profileId: '' }, null)), null, 'no connection');
  const task = { effectiveProfile: null, reasoningEffort: 'low' };
  const follow = fieldOf(await render('vi', { hub: hub(), profileId: undefined, task }, CLAUDE));
  assert.equal(follow.options[0].text, 'Mặc định (Thấp)', 'the default of a conversation is the level it has');
});

test('every key of the chip is in both languages', () => {
  const keys = Object.keys(translations.vi).filter((key) => key.startsWith('agents_tr_'));
  assert.deepEqual(keys.sort(), ['agents_tr_auto', 'agents_tr_default', 'agents_tr_label', 'agents_tr_select_label', 'agents_tr_title']);
  for (const key of keys) {
    assert.ok(translations.en[key]?.trim(), `en: ${key}`);
    if (translations.en[key] !== translations.vi[key]) assert.doesNotMatch(translations.en[key], DIACRITICS, `en.${key} reads Vietnamese`);
  }
});
