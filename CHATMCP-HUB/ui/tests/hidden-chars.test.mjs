import test from 'node:test';
import assert from 'node:assert/strict';
import { hasHidden, splitHidden } from '../src/lib/hidden-chars.ts';

// Text an AI wrote, and the diff of what it changed, can hold characters that cannot be seen but change what a reader sees: a right-to-left
// override reorders a line, a zero-width space splits a word that a search will not find. The viewers show them as visible markers.

test('direction-changing, zero-width and control characters are found; ordinary text, accents, emoji, tabs and newlines are not', () => {
  assert.equal(hasHidden('plain text with ünïcödé, 日本語, emoji 🎉 and\ttabs\nnewlines\r\n'), false);
  assert.equal(hasHidden(''), false);
  for (const ch of ['‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩', '‎', '‏', '؜',
    '​', '‌', '‍', '⁠', '﻿', '­', '᠎', '\u0007', '\u001B', '\u007F', '\u009B']) {
    assert.equal(hasHidden(`a${ch}b`), true, `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
  }
});

test('a text is split around its hidden characters, which are named in capitals with at least four digits', () => {
  assert.deepEqual(splitHidden('a‮b​c'), [{ text: 'a' }, { hidden: 'U+202E' }, { text: 'b' }, { hidden: 'U+200B' }, { text: 'c' }]);
  assert.deepEqual(splitHidden('﻿start'), [{ hidden: 'U+FEFF' }, { text: 'start' }]);
  assert.deepEqual(splitHidden('end\u0007'), [{ text: 'end' }, { hidden: 'U+0007' }]);
  assert.deepEqual(splitHidden('abc'), [{ text: 'abc' }]);
  assert.deepEqual(splitHidden(''), []);
  assert.deepEqual(splitHidden('‮‮'), [{ hidden: 'U+202E' }, { hidden: 'U+202E' }]);
});

test('nothing but the hidden characters is taken out: the visible text comes back whole', () => {
  const text = 'if (user.isAdmin ‮) { ⁦ grant(); } // 日本語 🎉\tend​';
  const visible = splitHidden(text).filter((part) => 'text' in part).map((part) => part.text).join('');
  assert.equal(visible, text.replace(/[‮⁦​]/g, ''));
});
