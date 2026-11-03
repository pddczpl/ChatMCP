// lib/line-diff.mjs: the line diff that the Hub itself computes for the approval card (P8 ux-7). The Hub has no runtime dependency, so the diff is written here;
// these tests are what keeps it honest.
//
//  1. the shape of a hunk: three lines of context, one hunk for changes six lines apart or fewer, the file's ends cut the context
//  2. exact text: CRLF, a missing final newline, a byte order mark, Unicode and a lone CR come back byte for byte in the rows
//  3. properties over thousands of seeded random pairs: the rows rebuild the new text from the old one, the counts are the rows, and the script is the shortest one
//     (compared with a plain longest-common-subsequence table)
//  4. the bounds: a change that is too scattered becomes one hunk, never a hang; a big file with one change costs nothing
//  5. hunksDigest tells every difference of a hunk apart and is stable
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CONTEXT_LINES, MAX_EDIT_LENGTH, diffHunks, hunksDigest, splitLines } from '../lib/line-diff.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
setTimeout(() => { console.error('FAIL: the line diff suite exceeded its own time budget'); process.exit(2); }, 120_000).unref();

const lines = (count, label = 'line') => Array.from({ length: count }, (_, index) => `${label} ${index + 1}\n`);
const rowsOf = (hunk) => hunk.rows.map((row) => `${row.kind[0]}${row.text.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}`);

// ------------------------------------------------------------------ 1. the shape
{
  assert.deepEqual(CONTEXT_LINES, 3);
  assert.deepEqual(diffHunks('a\nb\n', 'a\nb\n'), { hunks: [], additions: 0, deletions: 0 }, 'equal texts have no hunk');
  assert.deepEqual(diffHunks('', ''), { hunks: [], additions: 0, deletions: 0 });
  assert.deepEqual(diffHunks('x', 'x'), { hunks: [], additions: 0, deletions: 0 });

  const before = lines(20).join('');
  const after = lines(20).map((line) => (line === 'line 10\n' ? 'line TEN\n' : line)).join('');
  const one = diffHunks(before, after);
  assert.equal(one.hunks.length, 1);
  assert.equal(one.additions, 1);
  assert.equal(one.deletions, 1);
  const [hunk] = one.hunks;
  assert.deepEqual(rowsOf(hunk), ['cline 7\\n', 'cline 8\\n', 'cline 9\\n', 'rline 10\\n', 'aline TEN\\n', 'cline 11\\n', 'cline 12\\n', 'cline 13\\n'], 'three lines of context on each side');
  assert.deepEqual([hunk.baselineStart, hunk.baselineEnd, hunk.currentStart, hunk.currentEnd, hunk.removed, hunk.added], [9, 10, 9, 10, 1, 1], 'the numbers do not count the context');
  assert.equal(hunk.invisibleOnly, false);
  ok('one changed line: three lines of context on each side, the numbers of the change itself');

  // the ends of the file cut the context
  const first = diffHunks(lines(10).join(''), ['line ONE\n', ...lines(10).slice(1)].join('')).hunks[0];
  assert.deepEqual(rowsOf(first), ['rline 1\\n', 'aline ONE\\n', 'cline 2\\n', 'cline 3\\n', 'cline 4\\n']);
  const last = diffHunks(lines(10).join(''), [...lines(10).slice(0, 9), 'line LAST\n'].join('')).hunks[0];
  assert.deepEqual(rowsOf(last), ['cline 7\\n', 'cline 8\\n', 'cline 9\\n', 'rline 10\\n', 'aline LAST\\n']);
  assert.deepEqual([first.currentStart, last.currentStart], [0, 9]);
  ok('a change at the first or the last line has less context, never a row from outside the file');

  // changes six unchanged lines apart are one hunk, seven lines apart are two
  const swap = (text, ...numbers) => text.split('\n').map((line) => (numbers.some((n) => line === `line ${n}`) ? `${line} EDITED` : line)).join('\n');
  const base = lines(40).join('');
  const six = diffHunks(base, swap(base, 10, 17));
  assert.equal(six.hunks.length, 1, 'lines 10 and 17 have six lines between them');
  assert.equal(six.hunks[0].rows.filter((row) => row.kind === 'context').length, 3 + 6 + 3);
  const seven = diffHunks(base, swap(base, 10, 18));
  assert.equal(seven.hunks.length, 2, 'lines 10 and 18 have seven lines between them');
  assert.deepEqual(seven.hunks.map((item) => item.rows.filter((row) => row.kind === 'context').length), [6, 6]);
  assert.equal(seven.additions, 2);
  ok('changes with six unchanged lines between them are one hunk, seven lines make two');

  // adding and removing whole files
  const created = diffHunks('', 'a\nb\n');
  assert.deepEqual(rowsOf(created.hunks[0]), ['aa\\n', 'ab\\n']);
  assert.deepEqual([created.additions, created.deletions], [2, 0]);
  const emptied = diffHunks('a\nb\n', '');
  assert.deepEqual(rowsOf(emptied.hunks[0]), ['ra\\n', 'rb\\n']);
  assert.deepEqual([emptied.additions, emptied.deletions], [0, 2]);
  ok('a new file is all additions and an emptied file is all removals');
}

// ------------------------------------------------------------------ 2. exact text
{
  assert.deepEqual(splitLines('a\r\nb\nc'), ['a\r\n', 'b\n', 'c'], 'a line keeps its own terminator, the last one may have none');
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a\rb\n'), ['a\rb\n'], 'a lone carriage return does not end a line');
  assert.deepEqual(splitLines('\n\n'), ['\n', '\n']);

  // CRLF is kept
  const crlf = diffHunks('one\r\ntwo\r\nthree\r\n', 'one\r\nTWO\r\nthree\r\n');
  assert.deepEqual(rowsOf(crlf.hunks[0]), ['cone\\r\\n', 'rtwo\\r\\n', 'aTWO\\r\\n', 'cthree\\r\\n']);
  // a final newline that appears is a change of the last line
  const newline = diffHunks('a\nb', 'a\nb\n');
  assert.deepEqual(rowsOf(newline.hunks[0]), ['ca\\n', 'rb', 'ab\\n']);
  assert.deepEqual([newline.additions, newline.deletions], [1, 1]);
  const noNewline = diffHunks('a\nb\n', 'a\nb');
  assert.deepEqual(rowsOf(noNewline.hunks[0]), ['ca\\n', 'rb\\n', 'ab']);
  // LF becoming CRLF changes every line, and the hunk says that only the endings differ
  const ending = diffHunks('a\nb\n', 'a\r\nb\r\n');
  assert.equal(ending.additions, 2);
  assert.equal(ending.hunks[0].invisibleOnly, true, 'only the line endings differ');
  assert.equal(diffHunks('a\nb\n', 'a\nB\n').hunks[0].invisibleOnly, false);
  assert.equal(diffHunks('a\n', 'a\n\n').hunks[0].invisibleOnly, false, 'a line that appears is not invisible');
  assert.equal(diffHunks('a\r\nb\n', 'a\nB\n').hunks[0].invisibleOnly, false, 'one line says the same and the other does not');
  // a byte order mark inside the first line is a character like any other
  const bom = diffHunks('﻿a\nb\n', 'a\nb\n');
  assert.deepEqual(rowsOf(bom.hunks[0]), ['r﻿a\\n', 'aa\\n', 'cb\\n']);
  assert.equal(bom.hunks[0].invisibleOnly, true, 'a byte order mark alone is invisible');
  // Unicode, astral characters and a lone CR travel unchanged
  const unicode = 'Tiếng Việt: dấu sắc, hỏi — 😀 \u{1F9D1}‍\u{1F4BB}\n';
  const moved = diffHunks(unicode + 'tail\n', unicode.replace('sắc', 'sắc huyền') + 'tail\n');
  assert.equal(moved.hunks[0].rows[0].text, unicode);
  assert.equal(moved.hunks[0].rows.find((row) => row.kind === 'added').text, unicode.replace('sắc', 'sắc huyền'));
  const lone = diffHunks('a\rb\nc\n', 'a\rb\nC\n');
  assert.equal(lone.hunks[0].rows[0].text, 'a\rb\n', 'a lone carriage return stays in its line');
  ok('CRLF, a missing final newline, a byte order mark, Unicode and a lone CR are in the rows exactly as they are in the text');
}

// ------------------------------------------------------------------ 3. properties
/** The longest common subsequence length, by the plain table. */
function lcsLength(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  return table[0][0];
}
/** Rebuilds the new text from the old text and the hunks alone. */
function rebuild(oldText, hunks) {
  const old = splitLines(oldText);
  const pieces = [];
  let at = 0;
  for (const hunk of hunks) {
    const lead = hunk.rows.findIndex((row) => row.kind !== 'context');
    let tail = 0;
    while (tail < hunk.rows.length && hunk.rows[hunk.rows.length - 1 - tail].kind === 'context') tail += 1;
    const middle = hunk.rows.slice(lead, hunk.rows.length - tail);
    assert.ok(lead >= 0 && lead <= CONTEXT_LINES && tail <= CONTEXT_LINES, 'at most three lines of context on each side');
    assert.equal(middle.filter((row) => row.kind !== 'added').map((row) => row.text).join(''), old.slice(hunk.baselineStart, hunk.baselineEnd).join(''), 'the rows say what the old text had in the place of the change');
    assert.equal(middle.filter((row) => row.kind !== 'removed').length, hunk.currentEnd - hunk.currentStart);
    assert.equal(middle.filter((row) => row.kind !== 'added').length, hunk.baselineEnd - hunk.baselineStart);
    assert.equal(hunk.rows.slice(0, lead).map((row) => row.text).join(''), old.slice(hunk.baselineStart - lead, hunk.baselineStart).join(''), 'the context before is what precedes the change');
    assert.equal(hunk.rows.slice(hunk.rows.length - tail).map((row) => row.text).join(''), old.slice(hunk.baselineEnd, hunk.baselineEnd + tail).join(''), 'the context after is what follows the change');
    assert.ok(hunk.baselineStart >= at, 'hunks are in order and do not overlap');
    pieces.push(old.slice(at, hunk.baselineStart).join(''), middle.filter((row) => row.kind !== 'removed').map((row) => row.text).join(''));
    at = hunk.baselineEnd;
  }
  pieces.push(old.slice(at).join(''));
  return pieces.join('');
}
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
{
  const random = seeded(20261103);
  const pick = (count) => Math.floor(random() * count);
  const TOKENS = ['a', 'b', 'c', 'd', 'e', 'f', '', '}', 'x = 1;', 'x = 2;', 'tiếng', '😀'];
  const ENDINGS = ['\n', '\n', '\n', '\r\n'];
  const word = () => `${TOKENS[pick(TOKENS.length)]}${ENDINGS[pick(ENDINGS.length)]}`;
  let pairs = 0;
  let shortest = 0;
  for (let round = 0; round < 2500; round += 1) {
    const size = pick(26);
    const old = Array.from({ length: size }, word);
    let next = old.slice();
    if (round % 5 === 0) next = Array.from({ length: pick(26) }, word); // unrelated
    else for (let edits = pick(7); edits > 0; edits -= 1) {
      const at = pick(next.length + 1);
      const kind = pick(3);
      if (kind === 0) next.splice(at, 0, word());
      else if (kind === 1) next.splice(at, 1);
      else if (at < next.length) next[at] = word();
    }
    if (round % 11 === 0 && next.length) next[next.length - 1] = next[next.length - 1].replace(/\r?\n$/, ''); // no final newline
    const oldText = old.join('');
    const newText = next.join('');
    const result = diffHunks(oldText, newText);
    assert.equal(rebuild(oldText, result.hunks), newText, `round ${round}: the hunks turn the old text into the new one`);
    const rows = result.hunks.flatMap((hunk) => hunk.rows);
    assert.equal(result.additions, rows.filter((row) => row.kind === 'added').length, `round ${round}: additions are the added rows`);
    assert.equal(result.deletions, rows.filter((row) => row.kind === 'removed').length, `round ${round}: deletions are the removed rows`);
    assert.equal(result.additions, result.hunks.reduce((total, hunk) => total + hunk.added, 0));
    assert.equal(result.deletions, result.hunks.reduce((total, hunk) => total + hunk.removed, 0));
    if (oldText === newText) assert.equal(result.hunks.length, 0, `round ${round}: nothing changed`);
    // the script is the shortest one that exists
    const a = splitLines(oldText);
    const b = splitLines(newText);
    assert.equal(result.additions + result.deletions, a.length + b.length - 2 * lcsLength(a, b), `round ${round}: not the shortest script`);
    shortest += 1;
    // two hunks are never close enough to be one
    for (let at = 1; at < result.hunks.length; at += 1) assert.ok(result.hunks[at].baselineStart - result.hunks[at - 1].baselineEnd > 2 * CONTEXT_LINES, `round ${round}: hunks ${at - 1} and ${at} should have been one`);
    pairs += 1;
  }
  ok(`${pairs} seeded random pairs: the hunks rebuild the new text from the old one, the counts are the rows, ${shortest} scripts are as short as the longest-common-subsequence table says, hunks are never closer than seven lines`);
}

// ------------------------------------------------------------------ 4. the bounds
{
  assert.equal(MAX_EDIT_LENGTH, 1000);
  // too scattered to search: every second line of 3000 changes, which is more than 1000 edits
  const old = lines(3000).join('');
  const scattered = lines(3000).map((line, index) => (index % 2 === 0 ? line.replace('line', 'LINE') : line)).join('');
  let started = Date.now();
  const coarse = diffHunks(old, scattered);
  assert.ok(Date.now() - started < 3000, 'a scattered change is answered fast');
  assert.equal(coarse.hunks.length, 1, 'past the limit the change is one hunk from the first changed line to the last');
  assert.equal(rebuild(old, coarse.hunks), scattered, 'one hunk, but still exact');
  assert.equal(coarse.hunks[0].baselineStart, 0);
  assert.equal(coarse.hunks[0].baselineEnd, 2999, 'the last line is the same in both texts');
  ok('3000 lines with every second line changed: one hunk, exact, fast');

  // a big file with one change costs nothing
  const big = lines(120_000).join('');
  const edited = big.replace('line 60000\n', 'line SIXTY\n');
  started = Date.now();
  const one = diffHunks(big, edited);
  assert.ok(Date.now() - started < 1500, `one change in 120,000 lines took ${Date.now() - started} ms`);
  assert.equal(one.hunks.length, 1);
  assert.deepEqual([one.additions, one.deletions], [1, 1]);
  assert.equal(one.hunks[0].currentStart, 59_999);

  // a lot of repeated lines is the worst case of the search
  const repeated = Array.from({ length: 6000 }, () => 'same\n');
  const shuffled = repeated.slice();
  for (let at = 0; at < shuffled.length; at += 7) shuffled[at] = 'other\n';
  started = Date.now();
  const hard = diffHunks(repeated.join(''), shuffled.join(''));
  assert.ok(Date.now() - started < 3000, `repeated lines took ${Date.now() - started} ms`);
  assert.equal(rebuild(repeated.join(''), hard.hunks), shuffled.join(''));
  ok('120,000 lines with one change and 6000 repeated lines are answered in time, and exact');
}

// ------------------------------------------------------------------ 5. the digest
{
  const base = lines(30).join('');
  const changed = base.replace('line 15\n', 'line FIFTEEN\n');
  const { hunks } = diffHunks(base, changed);
  const digest = hunksDigest(hunks);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(hunksDigest(diffHunks(base, changed).hunks), digest, 'the same change has the same digest');
  assert.equal(hunksDigest([]), createHash('sha256').update('').digest('hex'), 'no hunk is the digest of nothing');
  const clone = () => JSON.parse(JSON.stringify(hunks));
  const mutations = {
    'a row text': (copy) => { copy[0].rows[0].text += ' '; },
    'a row kind': (copy) => { copy[0].rows[3].kind = 'added'; },
    'the order of two rows': (copy) => { [copy[0].rows[0], copy[0].rows[1]] = [copy[0].rows[1], copy[0].rows[0]]; },
    'a missing row': (copy) => { copy[0].rows.pop(); },
    'the place in the old text': (copy) => { copy[0].baselineStart += 1; },
    'the place in the new text': (copy) => { copy[0].currentStart += 1; },
    'the end in the old text': (copy) => { copy[0].baselineEnd += 1; },
    'the end in the new text': (copy) => { copy[0].currentEnd += 1; },
    'a second hunk': (copy) => { copy.push(structuredClone(copy[0])); },
  };
  for (const [what, change] of Object.entries(mutations)) {
    const copy = clone();
    change(copy);
    assert.notEqual(hunksDigest(copy), digest, `the digest sees ${what}`);
  }
  // rows that run together cannot be taken for other rows
  const joined = [{ baselineStart: 0, baselineEnd: 0, currentStart: 0, currentEnd: 2, rows: [{ kind: 'added', text: 'ab\n' }, { kind: 'added', text: 'c\n' }] }];
  const split = [{ baselineStart: 0, baselineEnd: 0, currentStart: 0, currentEnd: 2, rows: [{ kind: 'added', text: 'a' }, { kind: 'added', text: 'bc\n\n' }] }];
  assert.notEqual(hunksDigest(joined), hunksDigest(split), 'the length of each row is part of the digest');
  // the written form is part of the contract: a card and a test that both hash a change must hash the same bytes
  const written = (list) => list.map((hunk) => `@${hunk.baselineStart},${hunk.baselineEnd},${hunk.currentStart},${hunk.currentEnd}\n${hunk.rows.map((row) => `${row.kind[0]}${row.text.length}:${row.text}`).join('')}`).join('\u0000');
  assert.equal(digest, createHash('sha256').update(written(hunks)).digest('hex'), 'the digest is sha256 of the written form');
  assert.equal(hunksDigest(joined), createHash('sha256').update(written(joined)).digest('hex'));
  const spread = diffHunks(base, base.replace('line 5\n', 'FIVE\n').replace('line 25\n', 'TWENTY-FIVE\n')).hunks;
  assert.equal(spread.length, 2);
  assert.equal(hunksDigest(spread), createHash('sha256').update(written(spread)).digest('hex'), 'hunks are written one after the other, separated by NUL');
  ok('hunksDigest: stable, sha256 of a written form, sees every row, kind, order, place and count');
}

console.log(`PASS: ${checks} line diff checks`);
