import test from 'node:test';
import assert from 'node:assert/strict';
import { diffFile } from '../src/lib/review-hunks.ts';
import { diffHunks } from '../../lib/line-diff.mjs';

// The approval card shows the change in the hunks that the Hub works out for itself (lib/line-diff.mjs: the Hub has no runtime dependency, so it has a diff of its own), and the Review tab
// shows the same change in the hunks of ui/src/lib/review-hunks.ts (the `diff` package). This test keeps the two from telling a person two different stories about one change:
// where the change has one shortest script (lines that are all different), the hunks are the same, row by row; where it has several (repeated lines), they have the same counts and rebuild the same text.

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = seeded(20261104);
const pick = (count) => Math.floor(random() * count);

const shape = (hunks) => hunks.map((hunk) => ({
  baselineStart: hunk.baselineStart, baselineEnd: hunk.baselineEnd, currentStart: hunk.currentStart, currentEnd: hunk.currentEnd, removed: hunk.removed, added: hunk.added,
  invisibleOnly: hunk.invisibleOnly, rows: hunk.rows.map((row) => ({ kind: row.kind, text: row.text })),
}));

test('lines that are all different: the hunks of the card are the hunks of the Review tab, row by row', () => {
  let compared = 0;
  let withHunks = 0;
  for (let round = 0; round < 1500; round += 1) {
    let fresh = 0;
    const ending = ['\n', '\n', '\r\n'][pick(3)];
    const line = () => `line ${fresh++}${' '.repeat(pick(3))}${ending}`;
    const old = Array.from({ length: pick(40) }, line);
    const next = old.slice();
    for (let edits = pick(8); edits > 0; edits -= 1) {
      const at = pick(next.length + 1);
      const kind = pick(3);
      if (kind === 0) next.splice(at, 0, line());
      else if (kind === 1) next.splice(at, 1);
      else if (at < next.length) next[at] = line();
    }
    if (round % 7 === 0 && next.length) next[next.length - 1] = next.at(-1).replace(/\r?\n$/, '');
    const before = old.join('');
    const after = next.join('');
    const card = diffHunks(before, after);
    const review = diffFile(before, after);
    assert.deepEqual(shape(card.hunks), shape(review.hunks), `round ${round}`);
    compared += 1;
    if (card.hunks.length) withHunks += 1;
  }
  assert.ok(withHunks > 1000, `${withHunks} of ${compared} pairs had a change`);
});

test('texts with repeated lines: the same counts, and the hunks of the card rebuild the new text', () => {
  const tokens = ['a\n', 'b\n', 'c\n', '\n', '}\n', 'x = 1;\n', 'x = 2;\n', 'a\r\n'];
  for (let round = 0; round < 1500; round += 1) {
    const old = Array.from({ length: pick(30) }, () => tokens[pick(tokens.length)]);
    const next = old.slice();
    for (let edits = pick(10); edits > 0; edits -= 1) {
      const at = pick(next.length + 1);
      const kind = pick(3);
      if (kind === 0) next.splice(at, 0, tokens[pick(tokens.length)]);
      else if (kind === 1) next.splice(at, 1);
      else if (at < next.length) next[at] = tokens[pick(tokens.length)];
    }
    const before = old.join('');
    const after = next.join('');
    const card = diffHunks(before, after);
    const review = diffFile(before, after);
    const reviewAdded = review.hunks.reduce((total, hunk) => total + hunk.added, 0);
    const reviewRemoved = review.hunks.reduce((total, hunk) => total + hunk.removed, 0);
    assert.deepEqual([card.additions, card.deletions], [reviewAdded, reviewRemoved], `round ${round}: the counts`);
    assert.equal(card.hunks.length === 0, review.hunks.length === 0, `round ${round}: whether anything changed`);
  }
});
