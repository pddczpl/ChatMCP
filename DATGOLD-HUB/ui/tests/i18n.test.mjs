import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx } from './support/bundle.mjs';

// The models dictionary adds its strings to the base one when it is evaluated (the model picker's script does that in the page), so it is loaded too:
// the checks below read every string the interface can show.
const { loaded, dispose } = await bundleTsx(`
  export { translations, translate, addTranslations } from './src/lib/i18n';
  export { modelsVi } from './src/lib/i18n-models';
`, 'chatmcp-i18n-');
after(dispose);
const { translations, translate, addTranslations } = loaded;

const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
const DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;

test('translate fills {name} placeholders in the language asked for', () => {
  // any real key that carries a placeholder will do; the agents dictionary has several
  const key = Object.keys(translations.vi).find(name => placeholders(translations.vi[name]).length > 0);
  assert.ok(key, 'the Vietnamese dictionary has at least one string with a placeholder');
  const values = Object.fromEntries(placeholders(translations.vi[key]).map(name => [name, `<${name}>`]));
  for (const lang of ['vi', 'en']) {
    const filled = translate(lang, key, values);
    for (const name of Object.keys(values)) assert.ok(filled.includes(`<${name}>`), `${lang}: ${key} shows {${name}}`);
    assert.doesNotMatch(filled, /\{\w+\}/, `${lang}: ${key} has no placeholder left`);
  }
});

test('a placeholder that is not supplied stays visible instead of printing "undefined"', () => {
  const key = Object.keys(translations.vi).find(name => placeholders(translations.vi[name]).length > 0);
  const text = translate('vi', key, {});
  assert.match(text, /\{\w+\}/);
  assert.doesNotMatch(text, /undefined|NaN/);
});

test('a key with no parameters is returned as it is, even if it holds braces from a later edit', () => {
  assert.equal(translate('en', 'tab_agents'), translations.en.tab_agents);
  assert.equal(translate('vi', 'tab_agents'), translations.vi.tab_agents);
});

test('an unknown language or key falls back to Vietnamese, then to the key itself', () => {
  assert.equal(translate('fr', 'tab_agents'), translations.vi.tab_agents);
  assert.equal(translate('en', 'no_such_key'), 'no_such_key');
});

test('a key that English lacks (a string added to one language only) shows the Vietnamese text, not the raw key', () => {
  const key = 'tab_agents';
  const saved = translations.en[key];
  delete translations.en[key];
  try { assert.equal(translate('en', key), translations.vi[key]); } finally { translations.en[key] = saved; }
});

test('English and Vietnamese define exactly the same keys', () => {
  const vi = Object.keys(translations.vi).sort();
  const en = Object.keys(translations.en).sort();
  assert.deepEqual(vi.filter(key => !en.includes(key)), [], 'keys with no English text');
  assert.deepEqual(en.filter(key => !vi.includes(key)), [], 'keys with no Vietnamese text');
});

test('every string has text, and the two languages use the same placeholders', () => {
  for (const key of Object.keys(translations.vi)) {
    assert.ok(String(translations.vi[key]).trim(), `vi.${key} is empty`);
    assert.ok(String(translations.en[key]).trim(), `en.${key} is empty`);
    assert.deepEqual(placeholders(translations.en[key]), placeholders(translations.vi[key]), `${key}: placeholders differ between languages`);
  }
});

test('the English text is not the Vietnamese text left in place (agents dictionary)', () => {
  const agentKeys = Object.keys(translations.vi).filter(key => key.startsWith('agents_') || key.startsWith('agent_') || key.startsWith('coding_') || key.startsWith('group_'));
  assert.ok(agentKeys.length > 40, `the agents dictionary has ${agentKeys.length} keys`);
  const diacritics = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
  for (const key of agentKeys) assert.doesNotMatch(translations.en[key], diacritics, `en.${key} still reads Vietnamese: ${translations.en[key]}`);
});

test('every status a worker, a run or a merge can have reads in plain words in both languages', () => {
  for (const status of ['pending', 'queued', 'preparing', 'planning', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'needs_attention', 'ready_for_review', 'awaiting_test_grant', 'testing', 'blocked', 'skipped', 'no_changes', 'conflict', 'partial_failure', 'published', 'draft_pr_created', 'verified']) {
    for (const lang of ['vi', 'en']) assert.ok(translations[lang][`agent_status_${status}`]?.trim(), `${lang}: no word for ${status}`);
  }
});

test('no English value holds Vietnamese, except the name of the Vietnamese language written in Vietnamese', () => {
  const holding = Object.keys(translations.en).filter(key => DIACRITICS.test(translations.en[key]));
  assert.deepEqual(holding, ['lang_vi'], `English values that still read Vietnamese: ${holding.join(', ')}`);
  assert.equal(translations.en.lang_vi, 'Tiếng Việt (Vietnamese)', 'a language is named in its own words in the list of languages');
});

// These strings are the same in both languages. Most are names (the product, a mode, a field of an API) that the Vietnamese screen has always shown in English;
// the words of the workflow card and the accessible names of the review controls are English on the Vietnamese screen on purpose (the comment in
// lib/i18n-agents.ts says so, and the unit and end-to-end tests match them there). A NEW string that is the same in both languages is almost always a
// translation that was forgotten, so it fails here: translate it, or add its key below with the reason.
const KEPT_IN_ENGLISH = [
  'welcome_title', 'perm_full_access', 'mode_full_access', 'mode_review', 'tab_terminal', 'terminal_title', 'backend_status', 'cat_devops', 'ai_base_url', 'ai_api_key',
  'ai_model_status_alpha', 'ai_model_status_beta', 'agents_git_refs', 'agents_mp_gateway',
  'agents_bg_workspace_fallback', 'agents_bg_detail_workspace', 'agents_bg_tasks_one', 'agents_bg_subagents_one', 'agents_bg_subagents_other', 'agents_bg_tokens',
  'agents_wf_completed', 'agents_wf_cancelled', 'agents_wf_needs_review', 'agents_wf_paused', 'agents_wf_running', 'agents_wf_agents_other', 'agents_wf_progress', 'agents_wf_tokens', 'agents_wf_phases',
  'agents_conv_profile_title', 'agents_mp_label', 'agents_mp_select_label', 'agents_mp_roles', 'agents_mp_roles_field',
  'agents_out_approve_name', 'agents_out_withhold_name', 'agents_out_redact_name',
];

test('a string that is the same in both languages is on the list of those kept in English on purpose', () => {
  const same = Object.keys(translations.vi).filter(key => translations.vi[key] === translations.en[key]).sort();
  assert.deepEqual(same.filter(key => !KEPT_IN_ENGLISH.includes(key)), [], 'the same text in both languages: translate it, or add the key to KEPT_IN_ENGLISH');
  assert.deepEqual(KEPT_IN_ENGLISH.filter(key => !same.includes(key)).sort(), [], 'these keys are no longer the same in both languages (or are gone): take them off the list');
});

test('a Vietnamese string with no Vietnamese letter does not read as English either', () => {
  const stopwords = /\b(the|and|of|to|is|for|this|with|you|not|are|your|will|can|from|has|have|by|be|it|in|on|at|or|an)\b/gi;
  const english = Object.keys(translations.vi).filter(key => !KEPT_IN_ENGLISH.includes(key) && !DIACRITICS.test(translations.vi[key]) && (translations.vi[key].match(stopwords) || []).length >= 2);
  assert.deepEqual(english.map(key => `${key}: ${translations.vi[key]}`), []);
});

// ---- plurals: t(key, { count }) -------------------------------------------------------------------------------------------------------------------

test('a count chooses the plural form the language has: English one and other, Vietnamese only other', () => {
  addTranslations(
    { zz_file_one: '{count} tệp', zz_file_other: '{count} tệp' },
    { zz_file_one: '{count} file', zz_file_other: '{count} files' },
  );
  for (const [count, english] of [[0, '0 files'], [1, '1 file'], [2, '2 files'], [5, '5 files'], [21, '21 files'], [1.5, '1.5 files']]) assert.equal(translate('en', 'zz_file', { count }), english, `en ${count}`);
  for (const count of [0, 1, 2, 5]) assert.equal(translate('vi', 'zz_file', { count }), `${count} tệp`, `vi ${count}`);
});

test('a plural family falls back to its _other form, then to the Vietnamese family, then to the plain key', () => {
  addTranslations(
    { zz_both_other: '{count} thứ', zz_viewed_one: '{count} lượt xem', zz_viewed_other: '{count} lượt xem', zz_plain: 'Đã xác nhận {count}' },
    { zz_both_other: '{count} things', zz_plain: 'Confirmed {count}' },
  );
  assert.equal(translate('en', 'zz_both', { count: 1 }), '1 things', 'English has no _one: its _other is used');
  assert.equal(translate('en', 'zz_viewed', { count: 3 }), '3 lượt xem', 'English has no family at all: the Vietnamese one is used');
  assert.equal(translate('en', 'zz_plain', { count: 3 }), 'Confirmed 3', 'a key with no plural forms and a {count} placeholder is a plain key, as before');
  assert.equal(translate('vi', 'zz_plain', { count: 3 }), 'Đã xác nhận 3');
  assert.equal(translate('fr', 'zz_both', { count: 2 }), '2 thứ', 'an unknown language speaks Vietnamese, plurals included');
});

test('a count that is not a finite number does not choose a form, and with no count nothing changes', () => {
  for (const count of [Number.NaN, Number.POSITIVE_INFINITY, '2', undefined]) assert.equal(translate('en', 'zz_file', { count }), 'zz_file', `count ${String(count)}`);
  assert.equal(translate('en', 'zz_file'), 'zz_file');
  assert.equal(translate('en', 'zz_file_one', { count: 1 }), '1 file', 'a key that is already a full form is asked for as it is');
  assert.equal(translate('en', 'zz_file_other', { n: 3, count: 3 }), '3 files');
});

test('the pairs of _one and _other that the dictionaries already have also work through a count', () => {
  const families = Object.keys(translations.vi).filter(key => key.endsWith('_one') && `${key.slice(0, -4)}_other` in translations.vi && !key.startsWith('zz_')).map(key => key.slice(0, -4));
  assert.ok(families.length >= 5, `found ${families.length} families`);
  for (const base of families) {
    assert.equal(translate('en', base, { count: 1, n: 1 }), translate('en', `${base}_one`, { count: 1, n: 1 }), `${base}: one`);
    assert.equal(translate('en', base, { count: 3, n: 3 }), translate('en', `${base}_other`, { count: 3, n: 3 }), `${base}: other`);
    // Vietnamese has no grammatical number: Intl.PluralRules gives "other" for every count, one included, so the _one form of a Vietnamese pair is never chosen by a count.
    for (const count of [0, 1, 2]) assert.equal(translate('vi', base, { count, n: count }), translate('vi', `${base}_other`, { count, n: count }), `${base}: Vietnamese ${count}`);
  }
});
