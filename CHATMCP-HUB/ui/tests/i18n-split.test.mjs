import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx } from './support/bundle.mjs';
import { firstDictionary, keysAsked, modulesByLoad, sectionsDictionary, sourceOf } from './support/dictionary-split.mjs';

// The dictionary has two parts. lib/i18n.ts and lib/i18n-agents.ts load with the first screen. lib/i18n-agents-sections.ts holds the strings that
// only the two Agents sections ask for and loads with them (every module that asks for one imports it), so that the first screen does not carry
// the ~200 strings it never shows. A string a first-screen module asks for must be in the first part: otherwise the screen shows the raw key until
// a section has been opened. What loads with the first screen comes from a real bundler run (modulesByLoad), what a module asks for from its source.

const SECTIONS = 'src/lib/i18n-agents-sections.ts';
const DICTIONARY_FILES = ['src/lib/i18n.ts', 'src/lib/i18n-agents.ts', SECTIONS];
const SECTIONS_IMPORT = /^import\s+['"]@\/lib\/i18n-agents-sections['"];?\s*(?:\/\/.*)?$/m;

const { first, later } = await modulesByLoad();
const firstKeys = Object.keys((await firstDictionary()).vi);
let sectionsPart;
const sections = async () => (sectionsPart ??= await sectionsDictionary());
const everyKey = async () => [...firstKeys, ...Object.keys((await sections()).vi)];
/** The keys the modules in `files` ask for (the dictionary files themselves only define them). */
const askedBy = (files, keys) => new Set([...files].filter((file) => !DICTIONARY_FILES.includes(file)).flatMap((file) => [...keysAsked(sourceOf(file), keys)]));

test('the scanner finds a key held whole and every key of a family built at run time, and not a class list or a comment', () => {
  const keys = ['send', 'coding_title', 'agent_status_running', 'agent_status_failed', 'agent_error_hub_busy', 'agent_errors_total', 'ab_thing'];
  const source = "t('coding_title'); const a = `agent_status_${status}`; const b = 'agent_error_' + code; const c = 'flex items-center'; /* t('send') */ // t('send')";
  assert.deepEqual([...keysAsked(source, keys)].sort(), ['agent_error_hub_busy', 'agent_status_failed', 'agent_status_running', 'coding_title']);
  assert.deepEqual([...keysAsked("const d = 'ab_'; const e = `${prefix}_title`;", keys)], [], 'a beginning too short to name a family, or none at all, asks for nothing');
});

test('the bundler run tells what loads with the first screen from what only an import() reaches', () => {
  const inspector = (file) => `src/components/inspector/${file}`;
  for (const file of ['AgentsTab.tsx', 'OrchestratorTab.tsx', 'IsolatedChecksPanel.tsx', 'DiffView.tsx', 'HiddenText.tsx', 'useDelegation.ts', 'agentLabels.ts']) assert.ok(first.has(inspector(file)), `${file} should load with the first screen`);
  for (const file of ['AgentGroups.tsx', 'DynamicSubagents.tsx', 'ManualGroup.tsx', 'CodingWorkers.tsx', 'CodingRunView.tsx', 'CodingWorkerCard.tsx', 'CodingReview.tsx', 'ConfirmDialog.tsx', 'agent-parts.tsx']) {
    assert.ok(later.has(inspector(file)) && !first.has(inspector(file)), `${file} should load only with a section`);
  }
  assert.ok(first.has('src/lib/agent-errors.ts') && first.has('src/lib/i18n.ts'));
});

test('every string a first-screen module asks for is in the part of the dictionary that loads with the first screen', async () => {
  const known = new Set(firstKeys);
  const all = await everyKey();
  const missing = [];
  for (const file of first) {
    if (DICTIONARY_FILES.includes(file)) continue;
    for (const key of keysAsked(sourceOf(file), all)) if (!known.has(key)) missing.push(`${file}: ${key}`);
  }
  assert.deepEqual(missing, [], 'a first-screen module asks for a string that arrives only with a section, so the screen would show the key: define it in lib/i18n-agents.ts');
});

test('the first part of the dictionary holds no string that only modules loading later ask for', async () => {
  const all = await everyKey();
  const askedFirst = askedBy(first, all);
  const askedLater = askedBy(later, all);
  const movable = firstKeys.filter((key) => askedLater.has(key) && !askedFirst.has(key));
  assert.deepEqual(movable, [], 'these strings are asked for only by modules that load with a section: define them in lib/i18n-agents-sections.ts, not in the part every user downloads first');
});

test('the sections part is in no script the first screen loads, and the sections bring it', () => {
  assert.ok(!first.has(SECTIONS), 'the first screen loads the sections part');
  assert.ok(later.has(SECTIONS), 'no section loads the sections part');
});

test('a module that asks for a string of the sections imports them, so it has its words wherever it is rendered', async () => {
  const own = new Set(Object.keys((await sections()).vi));
  assert.ok(own.size > 0, 'the sections part has strings');
  const bare = [...later].filter((file) => !DICTIONARY_FILES.includes(file)).filter((file) => {
    const asksOwn = [...keysAsked(sourceOf(file), [...firstKeys, ...own])].some((key) => own.has(key));
    return asksOwn && !SECTIONS_IMPORT.test(sourceOf(file));
  });
  assert.deepEqual(bare, [], "a module asks for the sections' strings without importing '@/lib/i18n-agents-sections'");
});

test('the two parts share no key, and the sections have the same keys and placeholders in both languages', async () => {
  const { vi, en } = await sections();
  const own = Object.keys(vi);
  assert.deepEqual(own.filter((key) => firstKeys.includes(key)), [], 'a key in both parts: the one that loads later would silently replace the other');
  assert.deepEqual(Object.keys(en).sort(), own.slice().sort(), 'Vietnamese and English define different keys');
  const holders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const key of own) {
    assert.ok(String(vi[key]).trim() && String(en[key]).trim(), `${key} has no text`);
    assert.deepEqual(holders(en[key]), holders(vi[key]), `${key}: placeholders differ between languages`);
  }
});

test('the sections add their strings to the dictionary as they load: absent before, in both languages after', async () => {
  const { vi, en } = await sections();
  const before = await firstDictionary();
  const { loaded, dispose } = await bundleTsx("export { translations, translate } from './src/lib/i18n'; import './src/lib/i18n-agents-sections';", 'chatmcp-sections-');
  try {
    for (const key of Object.keys(vi)) {
      assert.ok(!(key in before.vi) && !(key in before.en), `${key} is in the part that loads first`);
      assert.equal(loaded.translations.vi[key], vi[key], `vi.${key} was not added`);
      assert.equal(loaded.translations.en[key], en[key], `en.${key} was not added`);
      assert.equal(loaded.translate('en', key), en[key], `en.${key} is not what the screen shows`);
    }
  } finally {
    await dispose();
  }
});
