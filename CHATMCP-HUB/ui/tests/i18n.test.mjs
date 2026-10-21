import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx } from './support/bundle.mjs';

// The strings only the Agents sections ask for join the dictionary when their module is evaluated (as they do when a section loads); the
// import below puts them in, so that these tests cover the whole dictionary and not just the part that loads with the first screen.
const { loaded, dispose } = await bundleTsx(`
  export { translations, translate } from './src/lib/i18n';
  export { assessWorker, assessReport } from './src/lib/agent-proof';
  import './src/lib/i18n-agents-sections';
`, 'chatmcp-i18n-');
after(dispose);
const { translations, translate, assessWorker, assessReport } = loaded;

const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

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

test('every kind of evidence the helpers can report has a title and a note in both languages', () => {
  const kinds = new Set();
  for (const status of ['queued', 'running', 'awaiting_test_grant', 'ready_for_review', 'no_changes', 'failed', 'needs_attention', 'blocked', 'cancelled', 'interrupted', 'completed', 'something_new']) {
    kinds.add(assessWorker({ status }).kind);
    kinds.add(assessReport(status).kind);
  }
  kinds.add(assessWorker({ status: 'ready_for_review', verifyRequired: true, verificationOutcome: { state: 'ready_for_review' }, verificationAttempts: [{ checkId: 'c', testOutcomeVerified: true }] }).kind);
  kinds.add(assessWorker({ status: 'ready_for_review', verificationAttempts: [{ checkId: 'c', status: 'failed' }] }).kind);
  assert.deepEqual([...kinds].sort(), ['ai-report', 'attention', 'awaiting-grant', 'check-failed', 'failed', 'no-changes', 'stopped', 'unverified', 'verified', 'working']);
  for (const kind of kinds) {
    for (const lang of ['vi', 'en']) {
      for (const part of ['title', 'note']) {
        const key = `agent_proof_${kind.replace(/-/g, '_')}_${part}`;
        assert.ok(translations[lang][key]?.trim(), `${lang}.${key} is missing`);
      }
    }
  }
});

test('every status a worker, a run or a merge can have reads in plain words in both languages', () => {
  for (const status of ['pending', 'queued', 'preparing', 'planning', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'needs_attention', 'ready_for_review', 'awaiting_test_grant', 'testing', 'blocked', 'skipped', 'no_changes', 'conflict', 'partial_failure', 'published', 'draft_pr_created', 'verified']) {
    for (const lang of ['vi', 'en']) assert.ok(translations[lang][`agent_status_${status}`]?.trim(), `${lang}: no word for ${status}`);
  }
  for (const role of ['planner', 'researcher', 'tester', 'reviewer', 'security', 'summarizer']) {
    for (const lang of ['vi', 'en']) assert.ok(translations[lang][`agent_role_${role}`]?.trim(), `${lang}: no word for ${role}`);
  }
});
