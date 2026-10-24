import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { baseKeys, deadKeys, otherDictionariesTextOf, sourceTextOf } from './support/dead-keys.mjs';

// The base dictionary (src/lib/i18n.ts) is in the first script of the page, so a key that no module asks for is paid for by everyone and read by nobody.
// This test keeps the list of such keys empty: add the module that asks for a key, or leave the key out.
const ui = fileURLToPath(new URL('..', import.meta.url));
const dictionaryText = fs.readFileSync(new URL('../src/lib/i18n.ts', import.meta.url), 'utf8');
const sourceText = sourceTextOf(ui);
const otherDictionariesText = otherDictionariesTextOf(ui);

test('every key of the base dictionary is asked for by a module, in both languages', () => {
  const keys = baseKeys(dictionaryText);
  assert.ok(keys.vi.length > 100 && keys.vi.length === keys.en.length, `read the dictionary: ${keys.vi.length} Vietnamese keys, ${keys.en.length} English`);
  assert.deepEqual(keys.vi, keys.en, 'both languages hold the same keys, in the same order');
  assert.deepEqual(deadKeys({ dictionaryText, sourceText, otherDictionariesText }), { vi: [], en: [] }, 'keys that nothing asks for: remove them (or ask for them)');
});

test('the check can fail: a key that nothing asks for is found, one that a module asks for is not', () => {
  // a copy of the dictionary text with one more key in each language
  const extra = (key) => dictionaryText.replace(/^( {2}(?:vi|en): \{\r?\n)/gm, `$1    ${key}: 'x',\n`);
  const found = deadKeys({ dictionaryText: extra('zz_nobody_asks'), sourceText, otherDictionariesText });
  assert.deepEqual(found, { vi: ['zz_nobody_asks'], en: ['zz_nobody_asks'] });
  // asked for by name in a module, with any quote
  for (const quote of ["'", '"', '`']) {
    assert.deepEqual(deadKeys({ dictionaryText: extra('zz_asked'), sourceText: `${sourceText}\nconst k = ${quote}zz_asked${quote};`, otherDictionariesText }), { vi: [], en: [] }, `a key in ${quote}quotes${quote}`);
  }
  // asked for as a property
  assert.deepEqual(deadKeys({ dictionaryText: extra('zz_property'), sourceText: `${sourceText}\nx.zz_property;`, otherDictionariesText }), { vi: [], en: [] });
  // made at run time from a prefix that ends with an underscore, in a template or in a string
  assert.deepEqual(deadKeys({ dictionaryText: extra('zz_family_one'), sourceText: `${sourceText}\nt(\`zz_family_\${n}\`);`, otherDictionariesText }), { vi: [], en: [] });
  assert.deepEqual(deadKeys({ dictionaryText: extra('zz_group_one'), sourceText: `${sourceText}\nt('zz_group_' + n);`, otherDictionariesText }), { vi: [], en: [] });
  // asked for by one of the other two dictionaries
  assert.deepEqual(deadKeys({ dictionaryText: extra('zz_shared'), sourceText, otherDictionariesText: `${otherDictionariesText}\nconst k = 'zz_shared';` }), { vi: [], en: [] });
  // a word that only looks like it is not a use: the key is a part of another word
  assert.deepEqual(deadKeys({ dictionaryText: extra('zz_part'), sourceText: `${sourceText}\nconst k = 'zz_part_of_another_word';`, otherDictionariesText }).vi, ['zz_part']);
});

test('the reader refuses a dictionary that does not have the shape it knows', () => {
  assert.throws(() => baseKeys('export const translations = { en: { a: "x" }, vi: { a: "y" } };'), /does not have the shape/);
});
