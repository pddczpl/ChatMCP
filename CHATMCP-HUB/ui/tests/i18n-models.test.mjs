import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx } from './support/bundle.mjs';
import { dictionaryOf, firstDictionary, keysAsked, modulesByLoad, sectionsDictionary, sourceOf } from './support/dictionary-split.mjs';

// The words of the model picker are a third part of the dictionary (lib/i18n-models.ts), like the sections of the Agents tab (tests/i18n-split.test.mjs): they load with the picker, which is a
// script of its own, so the first screen does not carry them. What the first screen loads comes from a real bundler run, what a module asks for from its source. A string a first-screen module
// also asks for belongs in lib/i18n.ts, or the screen would show its key until the AI settings were opened.
const MODELS = 'src/lib/i18n-models.ts';
const MODELS_IMPORT = /^import\s+['"]@\/lib\/i18n-models['"];?\s*(?:\/\/.*)?$/m;
const DICTIONARY_FILES = ['src/lib/i18n.ts', 'src/lib/i18n-agents.ts', 'src/lib/i18n-agents-sections.ts', MODELS];

const { first, later } = await modulesByLoad();
const models = await dictionaryOf("export { modelsVi, modelsEn } from './src/lib/i18n-models';", ({ modelsVi, modelsEn }) => ({ vi: modelsVi, en: modelsEn }));
const before = await firstDictionary();
const sections = await sectionsDictionary();
const ownKeys = Object.keys(models.vi);

test('the picker is a script of its own: the field loads with the page, the picker, its status line, its rules and its words only with it', () => {
  assert.ok(first.has('src/components/inspector/ModelField.tsx'), 'the field loads with the page');
  assert.ok(first.has('src/components/inspector/IntelligenceTab.tsx'));
  for (const file of ['src/components/inspector/ModelPicker.tsx', 'src/components/inspector/CatalogStatus.tsx', 'src/lib/model-picker.ts', MODELS]) {
    assert.ok(later.has(file) && !first.has(file), `${file} should load only with the picker`);
  }
});

test('no module that loads with the first screen asks for a string of the picker', () => {
  const asking = [...first].filter((file) => !DICTIONARY_FILES.includes(file)).filter((file) => keysAsked(sourceOf(file), ownKeys).size > 0);
  assert.deepEqual(asking, [], 'a first-screen module asks for a picker string: the screen would show its key until the picker loads; define the string in lib/i18n.ts');
});

test('a module that asks for a string of the picker imports the picker\'s words, so it has them wherever it is rendered', () => {
  const bare = [...later].filter((file) => !DICTIONARY_FILES.includes(file)).filter((file) => keysAsked(sourceOf(file), ownKeys).size > 0 && !MODELS_IMPORT.test(sourceOf(file)));
  assert.deepEqual(bare, [], "a module asks for the picker's strings without importing '@/lib/i18n-models'");
  const using = [...later].filter((file) => !DICTIONARY_FILES.includes(file)).filter((file) => keysAsked(sourceOf(file), ownKeys).size > 0);
  assert.ok(using.includes('src/components/inspector/ModelPicker.tsx') && using.includes('src/components/inspector/CatalogStatus.tsx'), `the picker and its status line ask for them: ${using.join(', ')}`);
});

test('the picker shares no key with the other parts, and has the same keys and placeholders in both languages', () => {
  const others = new Set([...Object.keys(before.vi), ...Object.keys(sections.vi)]);
  assert.deepEqual(ownKeys.filter((key) => others.has(key)), [], 'a key in two parts: the one that loads later would silently replace the other');
  assert.deepEqual(Object.keys(models.en).sort(), ownKeys.slice().sort(), 'Vietnamese and English define different keys');
  const holders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const key of ownKeys) {
    assert.ok(String(models.vi[key]).trim() && String(models.en[key]).trim(), `${key} has no text`);
    assert.deepEqual(holders(models.en[key]), holders(models.vi[key]), `${key}: placeholders differ between languages`);
  }
  assert.ok(ownKeys.length >= 40, `${ownKeys.length} keys`);
});

test('the picker\'s words are added to the dictionary as it loads: absent before, in both languages after', async () => {
  const { loaded, dispose } = await bundleTsx("export { translations, translate } from './src/lib/i18n'; import './src/lib/i18n-models';", 'chatmcp-models-dictionary-');
  try {
    for (const key of ownKeys) {
      assert.ok(!(key in before.vi) && !(key in before.en), `${key} is in the part that loads first`);
      assert.equal(loaded.translations.vi[key], models.vi[key], `vi.${key} was not added`);
      assert.equal(loaded.translate('en', key), models.en[key], `en.${key} is not what the screen shows`);
    }
  } finally { await dispose(); }
});
