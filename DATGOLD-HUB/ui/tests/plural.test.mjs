import test from 'node:test';
import assert from 'node:assert/strict';
import { pluralCategory, pluralNames } from '../src/lib/plural.ts';

// Which plural form a count takes, by the rules of the language (Intl.PluralRules): English has "one" and "other", Vietnamese has only "other".
// translate() in lib/i18n.ts looks the names up in the dictionaries; tests/i18n.test.mjs checks that with the real ones.

test('English has a singular, and Vietnamese has none', () => {
  assert.deepEqual([0, 1, 2, 5, 21, 1.5].map((count) => pluralCategory('en', count)), ['other', 'one', 'other', 'other', 'other', 'other']);
  assert.deepEqual([0, 1, 2, 5, 21, 1.5].map((count) => pluralCategory('vi', count)), ['other', 'other', 'other', 'other', 'other', 'other']);
});

test('a language that is not English follows the Vietnamese rules, as in the dictionaries', () => {
  assert.equal(pluralCategory('fr', 1), 'other');
  assert.equal(pluralCategory('', 1), 'other');
});

test('the names to look up are the exact form, then _other, then the key itself', () => {
  assert.deepEqual(pluralNames('en', 'files', 1), ['files_one', 'files_other', 'files']);
  assert.deepEqual(pluralNames('en', 'files', 3), ['files_other', 'files_other', 'files']);
  assert.deepEqual(pluralNames('vi', 'files', 1), ['files_other', 'files_other', 'files']);
});

test('without a count that is a finite number the key is the only name', () => {
  for (const count of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '2', '', {}, true]) assert.deepEqual(pluralNames('en', 'files', count), ['files'], String(count));
  assert.deepEqual(pluralNames('en', 'files', 0), ['files_other', 'files_other', 'files'], 'zero is a count');
});
