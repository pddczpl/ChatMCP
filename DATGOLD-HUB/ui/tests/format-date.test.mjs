import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, formatNumber, formatRelative } from '../src/lib/format.ts';

// The date alone, a time that is more than a week old, and the grouping of numbers, in the language of the screen (tests/format.test.mjs has the rest of the helpers).
const at = new Date(2026, 9, 20, 14, 47, 31); // local time: 20 Oct 2026 14:47:31

test('a date alone follows the interface language, and Vietnamese is the default', () => {
  assert.equal(formatDate(at, 'vi'), '20/10/2026');
  assert.equal(formatDate(at, 'en'), 'Oct 20, 2026');
  assert.equal(formatDate(at), '20/10/2026');
  assert.equal(formatDate('not a date', 'vi'), '');
  assert.equal(formatDate(undefined, 'en'), '');
  assert.equal(formatDate('', 'en'), '');
  const early = new Date(2026, 0, 5, 9, 3);
  assert.equal(formatDate(early, 'vi'), '05/01/2026', 'two digits for the day and the month');
  assert.equal(formatDate(early, 'en'), 'Jan 5, 2026');
});

test('a time more than a week old is told as its whole date, in either language', () => {
  const now = at.getTime();
  const older = now - 10 * 86_400_000;
  assert.equal(formatRelative(older, 'vi', now), '10/10/2026');
  assert.equal(formatRelative(older, 'en', now), 'Oct 10, 2026', 'the month alone is not a date');
  assert.match(formatRelative(now - 6 * 86_400_000, 'en', now), /6 days ago/, 'less than a week is still told in days');
  assert.match(formatRelative(now - 604_799_000, 'en', now), /7 days ago/, 'one second short of a week is still told in days');
  assert.equal(formatRelative(now - 7 * 86_400_000, 'en', now), 'Oct 13, 2026', 'a week is told as a date');
  assert.equal(formatRelative(now - 7 * 86_400_000, 'vi', now), '13/10/2026');
});

test('numbers are grouped as the language groups them', () => {
  assert.equal(formatNumber(1234567.5, 'en'), '1,234,567.5');
  assert.equal(formatNumber(1234567.5, 'vi'), '1.234.567,5');
  assert.equal(formatNumber(32768, 'vi'), '32.768');
  assert.equal(formatNumber(32768), '32.768', 'Vietnamese is the default');
  assert.equal(formatNumber(undefined, 'en'), '–');
});
