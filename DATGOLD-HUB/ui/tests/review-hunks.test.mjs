import test from 'node:test';
import assert from 'node:assert/strict';
import * as sourceTypes from '../src/lib/review-source.ts';
import { CONTEXT_LINES, MAX_EDIT_LENGTH, acceptHunk, acceptHunks, diffFile, hashText, joinLines, pendingHunks, rejectAll, rejectHunk, rejectHunks, splitLines } from '../src/lib/review-hunks.ts';

// Two characters that cannot be seen in a source file are written with their code points, so that nobody has to take them on trust.
const BOM = String.fromCharCode(0xfeff);
const LINE_SEPARATOR = String.fromCharCode(0x2028);

// The model of the Review tab, without a page: a text is cut into lines that keep their own terminator, the lines of two versions are compared, the changes are grouped
// into hunks with three lines of context, and a hunk can be undone. Nothing here may change a byte it was not asked to change: a text is put together again by
// concatenating the original lines, never by joining them with a line feed, so that CRLF, a missing final newline and a leading byte order mark survive.

const numbered = (count, label = 'L') => Array.from({ length: count }, (_, index) => `${label}${index + 1}\n`);
const withLine = (lines, index, replacement) => lines.map((line, at) => (at === index ? replacement : line));
const show = (hunk) => hunk.rows.map((row) => `${row.kind}:${row.text.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}`);

test('the sizes the hunks are cut with are the ones of a unified diff: three lines of context', () => {
  assert.equal(CONTEXT_LINES, 3);
  assert.equal(MAX_EDIT_LENGTH, 1000);
});

// ---- lines ------------------------------------------------------------------------------------------------------------------------------------

test('a text is cut into lines that keep their own terminator, and put together again byte for byte', () => {
  const cases = [
    ['', []], ['\n', ['\n']], ['\n\n', ['\n', '\n']], ['a', ['a']], ['a\n', ['a\n']], ['a\nb', ['a\n', 'b']], ['a\nb\n', ['a\n', 'b\n']],
    ['a\r\nb\r\n', ['a\r\n', 'b\r\n']], ['a\r\nb\nc\r\n', ['a\r\n', 'b\n', 'c\r\n']], ['a\n\r\n', ['a\n', '\r\n']],
    ['a\rb\n', ['a\rb\n']], ['a\r', ['a\r']], [BOM + 'a\n', [BOM + 'a\n']], ['x' + LINE_SEPARATOR + 'y\n', ['x' + LINE_SEPARATOR + 'y\n']], ['😀\n😀', ['😀\n', '😀']],
  ];
  for (const [input, lines] of cases) {
    assert.deepEqual(splitLines(input), lines, JSON.stringify(input));
    assert.equal(joinLines(lines), input, `put together again: ${JSON.stringify(input)}`);
  }
});

test('only a line feed ends a line: a carriage return alone is part of the line, as Git has it', () => {
  assert.deepEqual(splitLines('one\rtwo\rthree'), ['one\rtwo\rthree']);
  assert.deepEqual(splitLines('one\r\ntwo\rthree\n'), ['one\r\n', 'two\rthree\n']);
});

// ---- hunks ------------------------------------------------------------------------------------------------------------------------------------

test('two texts that are the same have no hunk, and neither do two empty ones', () => {
  assert.deepEqual(diffFile('', '').hunks, []);
  assert.deepEqual(diffFile('a\nb\n', 'a\nb\n').hunks, []);
  assert.deepEqual(diffFile(`${BOM}a\r\nb`, `${BOM}a\r\nb`).hunks, []);
});

test('a change in the middle has three lines of context on each side and says where it is', () => {
  const baseline = numbered(10);
  const diff = diffFile(baseline.join(''), withLine(baseline, 4, 'X\n').join(''));
  assert.equal(diff.hunks.length, 1);
  const [hunk] = diff.hunks;
  assert.deepEqual([hunk.index, hunk.baselineStart, hunk.baselineEnd, hunk.currentStart, hunk.currentEnd, hunk.removed, hunk.added], [0, 4, 5, 4, 5, 1, 1]);
  assert.deepEqual(show(hunk), ['context:L2\\n', 'context:L3\\n', 'context:L4\\n', 'removed:L5\\n', 'added:X\\n', 'context:L6\\n', 'context:L7\\n', 'context:L8\\n']);
  assert.deepEqual(diff.baselineLines, baseline);
});

test('a change at the first line has no context before it, and one at the last line none after it', () => {
  const baseline = numbered(5);
  const first = diffFile(baseline.join(''), withLine(baseline, 0, 'X\n').join(''));
  assert.deepEqual(show(first.hunks[0]), ['removed:L1\\n', 'added:X\\n', 'context:L2\\n', 'context:L3\\n', 'context:L4\\n']);
  assert.deepEqual([first.hunks[0].baselineStart, first.hunks[0].currentEnd], [0, 1]);
  const last = diffFile(baseline.join(''), withLine(baseline, 4, 'X\n').join(''));
  assert.deepEqual(show(last.hunks[0]), ['context:L2\\n', 'context:L3\\n', 'context:L4\\n', 'removed:L5\\n', 'added:X\\n']);
  assert.deepEqual([last.hunks[0].baselineStart, last.hunks[0].baselineEnd], [4, 5]);
});

test('a short file has only the context it has', () => {
  const diff = diffFile('L1\nL2\n', 'L1\nX\n');
  assert.deepEqual(show(diff.hunks[0]), ['context:L1\\n', 'removed:L2\\n', 'added:X\\n']);
});

test('lines that were added or taken away are rows of one kind, and a replacement lists the old lines before the new ones', () => {
  const baseline = numbered(6);
  const inserted = diffFile(baseline.join(''), [...baseline.slice(0, 3), 'N\n', ...baseline.slice(3)].join(''));
  assert.deepEqual(show(inserted.hunks[0]), ['context:L1\\n', 'context:L2\\n', 'context:L3\\n', 'added:N\\n', 'context:L4\\n', 'context:L5\\n', 'context:L6\\n']);
  assert.deepEqual([inserted.hunks[0].baselineStart, inserted.hunks[0].baselineEnd, inserted.hunks[0].currentStart, inserted.hunks[0].currentEnd, inserted.hunks[0].removed, inserted.hunks[0].added], [3, 3, 3, 4, 0, 1]);
  const deleted = diffFile(baseline.join(''), [...baseline.slice(0, 2), ...baseline.slice(3)].join(''));
  assert.deepEqual(show(deleted.hunks[0]), ['context:L1\\n', 'context:L2\\n', 'removed:L3\\n', 'context:L4\\n', 'context:L5\\n', 'context:L6\\n']);
  assert.deepEqual([deleted.hunks[0].removed, deleted.hunks[0].added], [1, 0]);
  const replaced = diffFile(baseline.join(''), ['L1\n', 'A\n', 'B\n', 'C\n', ...baseline.slice(3)].join(''));
  assert.deepEqual(show(replaced.hunks[0]), ['context:L1\\n', 'removed:L2\\n', 'removed:L3\\n', 'added:A\\n', 'added:B\\n', 'added:C\\n', 'context:L4\\n', 'context:L5\\n', 'context:L6\\n']);
  assert.deepEqual([replaced.hunks[0].removed, replaced.hunks[0].added], [2, 3]);
});

test('two changes with six lines or fewer between them are one hunk; with seven they are two', () => {
  const baseline = numbered(30);
  const at = (a, b) => diffFile(baseline.join(''), withLine(withLine(baseline, a, 'A\n'), b, 'B\n').join(''));
  const six = at(2, 9);
  assert.equal(six.hunks.length, 1, 'six unchanged lines between the two changes');
  assert.deepEqual(show(six.hunks[0]), ['context:L1\\n', 'context:L2\\n', 'removed:L3\\n', 'added:A\\n', 'context:L4\\n', 'context:L5\\n', 'context:L6\\n', 'context:L7\\n', 'context:L8\\n', 'context:L9\\n',
    'removed:L10\\n', 'added:B\\n', 'context:L11\\n', 'context:L12\\n', 'context:L13\\n']);
  assert.deepEqual([six.hunks[0].baselineStart, six.hunks[0].baselineEnd, six.hunks[0].removed, six.hunks[0].added], [2, 10, 2, 2]);
  const seven = at(2, 10);
  assert.equal(seven.hunks.length, 2, 'seven unchanged lines between them');
  assert.deepEqual(show(seven.hunks[0]), ['context:L1\\n', 'context:L2\\n', 'removed:L3\\n', 'added:A\\n', 'context:L4\\n', 'context:L5\\n', 'context:L6\\n']);
  assert.deepEqual(show(seven.hunks[1]), ['context:L8\\n', 'context:L9\\n', 'context:L10\\n', 'removed:L11\\n', 'added:B\\n', 'context:L12\\n', 'context:L13\\n', 'context:L14\\n']);
  assert.deepEqual(seven.hunks.map((hunk) => hunk.index), [0, 1]);
  const five = at(2, 8);
  assert.equal(five.hunks.length, 1, 'five lines between them');
  const touching = at(2, 3);
  assert.equal(touching.hunks.length, 1, 'neighbouring lines');
  assert.deepEqual([touching.hunks[0].removed, touching.hunks[0].added], [2, 2]);
});

test('a chain of changes, each close to the one before, is one hunk however long the chain is', () => {
  const baseline = numbered(40);
  const current = [2, 9, 16, 23].reduce((lines, at) => withLine(lines, at, `X${at}\n`), baseline);
  const diff = diffFile(baseline.join(''), current.join(''));
  assert.equal(diff.hunks.length, 1);
  assert.deepEqual([diff.hunks[0].baselineStart, diff.hunks[0].baselineEnd, diff.hunks[0].removed, diff.hunks[0].added], [2, 24, 4, 4]);
  assert.equal(rejectAll(diff), baseline.join(''));
});

test('a text that is empty before or after is one hunk of lines that were added, or of lines that were taken away', () => {
  const added = diffFile('', 'a\nb\n');
  assert.equal(added.hunks.length, 1);
  assert.deepEqual(show(added.hunks[0]), ['added:a\\n', 'added:b\\n']);
  assert.deepEqual([added.hunks[0].baselineStart, added.hunks[0].baselineEnd, added.hunks[0].currentStart, added.hunks[0].currentEnd], [0, 0, 0, 2]);
  assert.equal(rejectHunk(added, 0), '');
  const gone = diffFile('a\nb\n', '');
  assert.deepEqual(show(gone.hunks[0]), ['removed:a\\n', 'removed:b\\n']);
  assert.deepEqual([gone.hunks[0].baselineStart, gone.hunks[0].baselineEnd, gone.hunks[0].currentStart, gone.hunks[0].currentEnd], [0, 2, 0, 0]);
  assert.equal(rejectHunk(gone, 0), 'a\nb\n');
});

test('a line whose only change is its terminator is a hunk of its own, and says so', () => {
  const crlf = diffFile('a\r\nb\r\nc\r\n', 'a\r\nb\nc\r\n');
  assert.equal(crlf.hunks.length, 1);
  assert.deepEqual(show(crlf.hunks[0]), ['context:a\\r\\n', 'removed:b\\r\\n', 'added:b\\n', 'context:c\\r\\n']);
  assert.equal(crlf.hunks[0].invisibleOnly, true);
  assert.equal(diffFile('a\nb\n', 'a\nB\n').hunks[0].invisibleOnly, false);
  assert.equal(diffFile('a\n', 'a').hunks[0].invisibleOnly, true, 'the final newline');
  assert.equal(diffFile(`${BOM}a\n`, 'a\n').hunks[0].invisibleOnly, true, 'the byte order mark');
  assert.equal(diffFile('a\r\nb\r\n', 'a\nB\n').hunks[0].invisibleOnly, false, 'one line changed in its words too');
  assert.equal(diffFile('', 'a\n').hunks[0].invisibleOnly, false, 'lines added are not look-alikes of nothing');
  assert.equal(diffFile('a\n', 'a\nb\n').hunks[0].invisibleOnly, false);
});

// ---- undoing hunks: bytes --------------------------------------------------------------------------------------------------------------------

const THREE = (() => {
  const baseline = numbered(40);
  const current = withLine(withLine(withLine(baseline, 3, 'one\n'), 20, 'two\n'), 36, 'three\n');
  return { baseline: baseline.join(''), current: current.join(''), diff: diffFile(baseline.join(''), current.join('')) };
})();

test('undoing the only hunk gives the baseline, and undoing none gives the current text', () => {
  const diff = diffFile(numbered(10).join(''), withLine(numbered(10), 4, 'X\n').join(''));
  assert.equal(rejectHunk(diff, 0), numbered(10).join(''));
  assert.equal(rejectHunks(diff, []), withLine(numbered(10), 4, 'X\n').join(''));
  assert.equal(rejectAll(diff), numbered(10).join(''));
});

test('undoing one of three hunks puts back only that one', () => {
  const { baseline, current, diff } = THREE;
  assert.equal(diff.hunks.length, 3);
  const lines = (text) => text.split('\n');
  assert.deepEqual(lines(rejectHunk(diff, 0)).filter((line, at) => line !== lines(current)[at]), ['L4'], 'the first hunk is undone, the others stay');
  assert.equal(rejectHunk(diff, 1), withLine(withLine(numbered(40), 3, 'one\n'), 36, 'three\n').join(''));
  assert.equal(rejectHunk(diff, 2), withLine(withLine(numbered(40), 3, 'one\n'), 20, 'two\n').join(''));
  assert.equal(rejectHunks(diff, [0, 2]), withLine(numbered(40), 20, 'two\n').join(''));
  assert.equal(rejectHunks(diff, [2, 0]), rejectHunks(diff, [0, 2]), 'the order does not matter');
  assert.equal(rejectHunks(diff, [0, 1, 2]), baseline);
  assert.equal(rejectAll(diff), baseline);
});

test('an index that is not a hunk of the file undoes nothing', () => {
  const { current, diff } = THREE;
  for (const index of [-1, 3, 99, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(rejectHunk(diff, index), current, String(index));
  assert.equal(rejectHunks(diff, [1, 1, 1]), rejectHunk(diff, 1), 'the same hunk three times is undone once');
  assert.equal(rejectHunks(diff, new Set([1])), rejectHunk(diff, 1), 'a set will do');
  assert.equal(rejectHunks(diff, [-1, 0, 7]), rejectHunk(diff, 0));
});

test('a file with Windows line endings keeps them, in the lines around a hunk and in the lines put back', () => {
  const crlf = (lines) => lines.map((line) => line.replace('\n', '\r\n'));
  const baseline = crlf(numbered(20));
  const current = withLine(withLine(baseline, 2, 'X\r\n'), 15, 'Y\r\n');
  const diff = diffFile(baseline.join(''), current.join(''));
  assert.equal(diff.hunks.length, 2);
  assert.equal(rejectHunk(diff, 0), withLine(baseline, 15, 'Y\r\n').join(''));
  assert.equal(rejectHunk(diff, 1), withLine(baseline, 2, 'X\r\n').join(''));
  assert.equal(rejectAll(diff), baseline.join(''));
  assert.ok(!/[^\r]\n/.test(rejectHunk(diff, 0)), 'no bare line feed appeared');
});

test('a file with Unix line endings keeps them', () => {
  const diff = diffFile(numbered(12).join(''), withLine(numbered(12), 5, 'X\n').join(''));
  assert.ok(!rejectHunk(diff, 0).includes('\r'));
  assert.equal(rejectHunk(diff, 0), numbered(12).join(''));
});

test('a file with mixed line endings gets back the ending each line had', () => {
  const baseline = ['a\r\n', 'b\n', 'c\r\n', 'd\n', 'e\r\n', 'f\n', 'g\r\n', 'h\n', 'i\r\n', 'j\n', 'k\r\n', 'l\n', 'm\r\n', 'n\n'];
  const current = withLine(withLine(baseline, 2, 'C\r\n'), 11, 'l\r\n');
  const diff = diffFile(baseline.join(''), current.join(''));
  assert.equal(diff.hunks.length, 2);
  assert.equal(diff.hunks[0].invisibleOnly, false, 'the line whose words changed');
  assert.equal(diff.hunks[1].invisibleOnly, true, 'the line that only changed its ending');
  assert.equal(rejectHunk(diff, 0), withLine(current, 2, 'c\r\n').join(''));
  assert.equal(rejectHunk(diff, 1), withLine(current, 11, 'l\n').join(''));
  assert.equal(rejectAll(diff), baseline.join(''));
});

test('a file that has no final newline, or has gained one, comes back as it was', () => {
  const without = diffFile('a\nb\nc', 'a\nb\nc\n');
  assert.equal(without.hunks.length, 1);
  assert.deepEqual(show(without.hunks[0]), ['context:a\\n', 'context:b\\n', 'removed:c', 'added:c\\n']);
  assert.equal(rejectHunk(without, 0), 'a\nb\nc');
  const lost = diffFile('a\nb\nc\n', 'a\nb\nc');
  assert.equal(rejectHunk(lost, 0), 'a\nb\nc\n');
  const edited = diffFile('a\nb\nc', 'a\nB\nc');
  assert.equal(rejectHunk(edited, 0), 'a\nb\nc', 'the last line stays without a terminator');
  const appended = diffFile('a\nb', 'a\nb\nc');
  assert.equal(appended.hunks.length, 1);
  assert.equal(rejectHunk(appended, 0), 'a\nb');
});

test('a byte order mark is part of the first line: it is kept, put back and taken away exactly', () => {
  const lost = diffFile(`${BOM}first\nsecond\n`, 'first\nsecond\n');
  assert.equal(lost.hunks.length, 1);
  assert.deepEqual(show(lost.hunks[0]), [`removed:${BOM}first\\n`, 'added:first\\n', 'context:second\\n']);
  assert.equal(rejectHunk(lost, 0), `${BOM}first\nsecond\n`);
  const gained = diffFile('first\nsecond\n', `${BOM}first\nsecond\n`);
  assert.equal(rejectHunk(gained, 0), 'first\nsecond\n');
  const kept = diffFile(`${BOM}a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n`, `${BOM}a\nb\nc\nd\ne\nf\ng\nh\nI\nj\n`);
  assert.equal(kept.hunks.length, 1);
  assert.equal(rejectHunk(kept, 0), `${BOM}a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n`);
  assert.equal(rejectHunks(kept, []).startsWith(BOM), true);
  const both = diffFile(`${BOM}a\nb\n`, `${BOM}A\nb\n`);
  assert.deepEqual(show(both.hunks[0]), [`removed:${BOM}a\\n`, `added:${BOM}A\\n`, 'context:b\\n']);
  assert.equal(rejectHunk(both, 0), `${BOM}a\nb\n`);
});

test('the first line and the last line of a file can each be undone', () => {
  const baseline = numbered(12);
  const current = withLine(withLine(baseline, 0, 'FIRST\n'), 11, 'LAST\n');
  const diff = diffFile(baseline.join(''), current.join(''));
  assert.equal(diff.hunks.length, 2);
  assert.equal(rejectHunk(diff, 0), withLine(baseline, 11, 'LAST\n').join(''));
  assert.equal(rejectHunk(diff, 1), withLine(baseline, 0, 'FIRST\n').join(''));
  assert.equal(rejectAll(diff), baseline.join(''));
});

test('lines added at the end and lines taken from the middle are undone exactly', () => {
  const baseline = numbered(30);
  const current = [...baseline.slice(0, 10), ...baseline.slice(13), 'tail 1\n', 'tail 2\n'];
  const diff = diffFile(baseline.join(''), current.join(''));
  assert.equal(diff.hunks.length, 2);
  assert.equal(rejectHunk(diff, 0), [...baseline, 'tail 1\n', 'tail 2\n'].join(''));
  assert.equal(rejectHunk(diff, 1), current.slice(0, -2).join(''));
});

test('a whole file that is new, or gone, can be undone as one hunk', () => {
  assert.equal(rejectAll(diffFile('', 'x\ny\nz\n')), '');
  assert.equal(rejectAll(diffFile('x\ny\nz\n', '')), 'x\ny\nz\n');
  assert.equal(rejectAll(diffFile('', '')), '');
  assert.equal(rejectAll(diffFile('\r\n', '')), '\r\n');
});

test('a file with one line, with and without a terminator, is handled', () => {
  assert.equal(rejectAll(diffFile('a', 'b')), 'a');
  assert.equal(rejectAll(diffFile('a\n', 'b\n')), 'a\n');
  assert.equal(rejectAll(diffFile('a', 'a\n')), 'a');
  assert.equal(rejectAll(diffFile('\n', '')), '\n');
  assert.equal(rejectAll(diffFile('', '\n')), '');
});

// ---- property tests: random files and random edits -------------------------------------------------------------------------------------------

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const POOL = ['', 'x', 'x', 'same', 'same', 'if (a) {', '}', '  return 1;', 'const s = "😀";', '\t', 'α β γ', 'a'.repeat(120), '// ---', 'ĐÃ XONG'];
const pick = (rand, list) => list[Math.floor(rand() * list.length)];

function randomLines(rand) {
  const mode = pick(rand, ['lf', 'crlf', 'mixed']);
  const eol = () => (mode === 'lf' ? '\n' : mode === 'crlf' ? '\r\n' : rand() < 0.5 ? '\n' : '\r\n');
  const lines = Array.from({ length: Math.floor(rand() * 45) }, () => pick(rand, POOL) + eol());
  if (lines.length && rand() < 0.3) lines[lines.length - 1] = lines[lines.length - 1].replace(/\r?\n$/, '');
  if (lines.length && rand() < 0.2) lines[0] = `${BOM}${lines[0]}`;
  return lines;
}

function randomEdits(rand, lines) {
  const out = lines.slice();
  const count = 1 + Math.floor(rand() * 6);
  for (let step = 0; step < count; step += 1) {
    const at = Math.floor(rand() * (out.length + 1));
    const eol = rand() < 0.5 ? '\n' : '\r\n';
    const kind = Math.floor(rand() * 7);
    if (kind === 0 && at < out.length) out[at] = `edited ${step}${out[at].match(/\r?\n$/)?.[0] ?? ''}`;
    else if (kind === 1) out.splice(at, 1 + Math.floor(rand() * 4));
    else if (kind === 2) out.splice(at, 0, ...Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, n) => `added ${step}.${n}${eol}`));
    else if (kind === 3 && at < out.length) out[at] = out[at].endsWith('\r\n') ? out[at].slice(0, -2) + '\n' : out[at].endsWith('\n') ? `${out[at].slice(0, -1)}\r\n` : out[at];
    else if (kind === 4 && out.length) out[out.length - 1] = /\n$/.test(out[out.length - 1]) ? out[out.length - 1].replace(/\r?\n$/, '') : `${out[out.length - 1]}\n`;
    else if (kind === 5 && out.length) out[0] = out[0].startsWith(BOM) ? out[0].slice(1) : `${BOM}${out[0]}`;
    else if (kind === 6 && at < out.length) out.splice(at, 0, out[at]);
  }
  return out;
}

/** An independent way to undo a set of hunks: splice from the last one to the first into a copy of the current lines. */
function undone(diff, which) {
  const lines = diff.currentLines.slice();
  for (const hunk of [...diff.hunks].reverse()) if (which.has(hunk.index)) lines.splice(hunk.currentStart, hunk.currentEnd - hunk.currentStart, ...diff.baselineLines.slice(hunk.baselineStart, hunk.baselineEnd));
  return lines.join('');
}

const CASES = 400;
function eachCase(check) {
  for (let seed = 1; seed <= CASES; seed += 1) {
    const rand = random(seed * 7919);
    const baselineLines = randomLines(rand);
    const currentLines = randomEdits(rand, baselineLines);
    check({ seed, rand, baseline: baselineLines.join(''), current: currentLines.join(''), diff: diffFile(baselineLines.join(''), currentLines.join('')) });
  }
}

test('property: any text is cut and put together again byte for byte', () => {
  eachCase(({ seed, baseline, current }) => {
    assert.equal(joinLines(splitLines(baseline)), baseline, `seed ${seed}`);
    assert.equal(joinLines(splitLines(current)), current, `seed ${seed}`);
    assert.ok(splitLines(baseline).every((line, at, all) => at === all.length - 1 || line.endsWith('\n')), `seed ${seed}: every line but the last ends with a line feed`);
  });
});

test('property: undoing every hunk gives the baseline bytes, and undoing none gives the current bytes', () => {
  let withChanges = 0;
  eachCase(({ seed, baseline, current, diff }) => {
    assert.equal(rejectAll(diff), baseline, `seed ${seed}: all undone`);
    assert.equal(rejectHunks(diff, diff.hunks.map((hunk) => hunk.index)), baseline, `seed ${seed}: all by index`);
    assert.equal(rejectHunks(diff, []), current, `seed ${seed}: none undone`);
    if (baseline !== current) withChanges += 1;
    assert.equal(diff.hunks.length === 0, baseline === current, `seed ${seed}: no hunk exactly when the texts are the same`);
  });
  assert.ok(withChanges > CASES * 0.8, `the cases are not all the same text: ${withChanges}`);
});

test('property: undoing any set of hunks gives what splicing the baseline lines into the current ones gives', () => {
  eachCase(({ seed, rand, diff }) => {
    for (const hunk of diff.hunks) assert.equal(rejectHunk(diff, hunk.index), undone(diff, new Set([hunk.index])), `seed ${seed}, hunk ${hunk.index}`);
    const which = new Set(diff.hunks.map((hunk) => hunk.index).filter(() => rand() < 0.5));
    assert.equal(rejectHunks(diff, which), undone(diff, which), `seed ${seed}, a random set`);
  });
});

test('property: hunks are in order, apart, and cut with three lines of context', () => {
  eachCase(({ seed, diff }) => {
    diff.hunks.forEach((hunk, at) => {
      const where = `seed ${seed}, hunk ${at}`;
      assert.equal(hunk.index, at, where);
      assert.ok(hunk.removed + hunk.added > 0, `${where}: a hunk changes something`);
      assert.ok(hunk.baselineStart <= hunk.baselineEnd && hunk.currentStart <= hunk.currentEnd, where);
      assert.ok(hunk.baselineEnd <= diff.baselineLines.length && hunk.currentEnd <= diff.currentLines.length, where);
      if (at > 0) {
        const before = diff.hunks[at - 1];
        assert.ok(hunk.currentStart - before.currentEnd >= 7, `${where}: seven lines or more from the one before`);
        assert.ok(hunk.baselineStart - before.baselineEnd >= 7, `${where}: seven lines or more from the one before, in the baseline`);
        assert.equal(hunk.currentStart - before.currentEnd, hunk.baselineStart - before.baselineEnd, `${where}: the lines between hunks are the same in both`);
      }
      const kinds = hunk.rows.map((row) => row.kind);
      const leading = kinds.findIndex((kind) => kind !== 'context');
      const trailing = kinds.length - 1 - kinds.map((kind) => kind !== 'context').lastIndexOf(true);
      assert.equal(leading, Math.min(CONTEXT_LINES, hunk.currentStart), `${where}: context before`);
      assert.equal(trailing, Math.min(CONTEXT_LINES, diff.currentLines.length - hunk.currentEnd), `${where}: context after`);
      let run = 0;
      for (const kind of kinds.slice(leading, kinds.length - trailing)) {
        run = kind === 'context' ? run + 1 : 0;
        assert.ok(run <= 2 * CONTEXT_LINES, `${where}: no more than six unchanged lines inside a hunk`);
      }
      assert.equal(hunk.removed, kinds.filter((kind) => kind === 'removed').length, where);
      assert.equal(hunk.added, kinds.filter((kind) => kind === 'added').length, where);
      const text = (keep) => hunk.rows.filter((row) => keep.includes(row.kind)).map((row) => row.text).join('');
      assert.equal(text(['context', 'removed']), diff.baselineLines.slice(hunk.baselineStart - leading, hunk.baselineEnd + trailing).join(''), `${where}: the rows hold the baseline`);
      assert.equal(text(['context', 'added']), diff.currentLines.slice(hunk.currentStart - leading, hunk.currentEnd + trailing).join(''), `${where}: the rows hold the current text`);
    });
  });
});

test('property: undoing the first hunk again and again, as the page does, ends at the baseline', () => {
  eachCase(({ seed, baseline, current, diff }) => {
    const budget = diff.hunks.reduce((total, hunk) => total + hunk.removed + hunk.added, 0);
    let now = current;
    let steps = 0;
    for (let again = diffFile(baseline, now); again.hunks.length; again = diffFile(baseline, now)) {
      now = rejectHunk(again, 0);
      steps += 1;
      assert.ok(steps <= budget, `seed ${seed}: it ends`);
    }
    assert.equal(now, baseline, `seed ${seed}`);
  });
});

// ---- size ------------------------------------------------------------------------------------------------------------------------------------

test('a big file with a few changes is cut into its few hunks', () => {
  const baseline = numbered(20000);
  const current = withLine(withLine(withLine(baseline, 100, 'a\n'), 10000, 'b\n'), 19990, 'c\n');
  const diff = diffFile(baseline.join(''), current.join(''));
  assert.equal(diff.hunks.length, 3);
  assert.equal(rejectAll(diff), baseline.join(''));
  assert.deepEqual(diff.hunks.map((hunk) => hunk.baselineStart), [100, 10000, 19990]);
});

test('hundreds of separate changes are still separate hunks', () => {
  const baseline = numbered(4000);
  const current = baseline.map((line, at) => (at % 10 === 5 ? `changed ${at}\n` : line));
  const diff = diffFile(baseline.join(''), current.join(''));
  assert.equal(diff.hunks.length, 400);
  assert.equal(diff.hunks[0].baselineStart, 5);
  assert.equal(rejectAll(diff), baseline.join(''));
  assert.equal(rejectHunk(diff, 399), baseline.map((line, at) => (at % 10 === 5 && at !== 3995 ? `changed ${at}\n` : line)).join(''));
});

test('past the limit of the search the changes become one hunk, from the first to the last, and the bytes are still exact', () => {
  const baseline = numbered(6000);
  const current = baseline.map((line, at) => (at % 10 === 0 && at > 0 && at < 6000 ? `changed ${at}\n` : line));
  const diff = diffFile(baseline.join(''), current.join(''));
  assert.equal(diff.hunks.length, 1, 'six hundred changes are more than the search looks for');
  assert.deepEqual([diff.hunks[0].baselineStart, diff.hunks[0].baselineEnd, diff.hunks[0].currentStart, diff.hunks[0].currentEnd], [10, 5991, 10, 5991]);
  assert.equal(rejectAll(diff), baseline.join(''));
  assert.equal(rejectHunks(diff, []), current.join(''));
  assert.ok(diff.hunks[0].fingerprint.length === 16);
});

test('two files that have nothing in common are one hunk of every line, and the lines they share at the ends are left out of it', () => {
  const alike = diffFile(numbered(3000, 'old ').join(''), numbered(3000, 'new ').join(''));
  assert.equal(alike.hunks.length, 1);
  assert.equal(alike.hunks[0].rows.length, 6000);
  assert.equal(rejectAll(alike), numbered(3000, 'old ').join(''));
  const middle = [...numbered(100, 'top '), ...numbered(2000, 'old '), ...numbered(100, 'end ')];
  const rewritten = [...numbered(100, 'top '), ...numbered(2000, 'new '), ...numbered(100, 'end ')];
  const diff = diffFile(middle.join(''), rewritten.join(''));
  assert.equal(diff.hunks.length, 1);
  assert.deepEqual([diff.hunks[0].baselineStart, diff.hunks[0].baselineEnd], [100, 2100]);
  assert.equal(diff.hunks[0].rows.filter((row) => row.kind === 'context').length, 2 * CONTEXT_LINES);
  assert.equal(rejectAll(diff), middle.join(''));
});

// ---- identity and accepting ------------------------------------------------------------------------------------------------------------------

test('the hash of a text is FNV-1a over its UTF-16 units, 64 bits, in sixteen hex digits', () => {
  // '', 'a' and 'foobar' are the published vectors of FNV-1a 64. The others were worked out by a separate program (Python integers over the UTF-16 units of the text).
  const vectors = {
    '': 'cbf29ce484222325',
    a: 'af63dc4c8601ec8c',
    foobar: '85944171f73967e8',
    '\u0000': 'af63bd4c8601b7df',
    aa: '089c4307b54596b7',
    'Đ': 'af62cd4c8600200f',
    '😀': 'e5e45a0a241b88d8',
    '😁': 'e5e45b0a241b8a8b',
    'Đã xong 😀': '7b26cc3e3c83d307',
  };
  for (const [text, hash] of Object.entries(vectors)) assert.equal(hashText(text), hash, JSON.stringify(text));
  assert.equal(hashText('aa').length, 16, 'a leading zero is kept');
  assert.equal(hashText('same'), hashText('same'));
});

test('a hunk is told from another by its content and its place, and stays the same when the file is compared again', () => {
  const baseline = numbered(30).map((line, at) => (at === 3 || at === 20 ? 'dup\n' : line));
  const current = baseline.map((line, at) => (line === 'dup\n' ? 'DUP\n' : line));
  const diff = diffFile(baseline.join(''), current.join(''));
  assert.equal(diff.hunks.length, 2);
  const [first, second] = diff.hunks;
  assert.match(first.fingerprint, /^[0-9a-f]{16}$/);
  assert.notEqual(first.fingerprint, second.fingerprint, 'the same change in two places');
  assert.deepEqual(diffFile(baseline.join(''), current.join('')).hunks.map((hunk) => hunk.fingerprint), diff.hunks.map((hunk) => hunk.fingerprint));
  const other = diffFile(baseline.join(''), current.map((line, at) => (at === 3 ? 'OTHER\n' : line)).join(''));
  assert.notEqual(other.hunks[0].fingerprint, first.fingerprint, 'other words');
  assert.equal(other.hunks[1].fingerprint, second.fingerprint, 'the hunk that did not change is the same');
});

test('two changes whose lines run together when written out are still told apart', () => {
  const ran = diffFile('x', 'y\n');
  const together = diffFile('xay\n', '');
  assert.deepEqual([ran.hunks.length, together.hunks.length], [1, 1]);
  assert.notEqual(ran.hunks[0].fingerprint, together.hunks[0].fingerprint);
});

test('a hunk with only lines added and a hunk with only lines taken away have fingerprints of their own', () => {
  const base = numbered(12).join('');
  const added = diffFile(base, `${base}X\n`);
  const removed = diffFile(`${base}X\n`, base);
  assert.notEqual(added.hunks[0].fingerprint, removed.hunks[0].fingerprint);
});

test('accepting a hunk marks it and nothing else, and never touches the text', () => {
  const { current, diff } = THREE;
  const none = new Set();
  const one = acceptHunk(none, diff.hunks[1]);
  assert.equal(none.size, 0, 'the set it was given is not changed');
  assert.deepEqual([...one], [diff.hunks[1].fingerprint]);
  assert.deepEqual(pendingHunks(diff.hunks, one).map((hunk) => hunk.index), [0, 2]);
  assert.deepEqual(pendingHunks(diff.hunks, none).map((hunk) => hunk.index), [0, 1, 2]);
  assert.equal(acceptHunk(one, diff.hunks[1]), one, 'accepting twice is accepting once: the very same set comes back');
  const all = acceptHunks(one, diff.hunks);
  assert.deepEqual(pendingHunks(diff.hunks, all), []);
  assert.equal(all.size, 3);
  assert.equal(one.size, 1, 'the set it was given is not changed');
  assert.equal(acceptHunks(all, diff.hunks), all, 'nothing new to accept: the very same set comes back');
  assert.equal(acceptHunks(none, []), none);
  assert.equal(rejectHunks(diff, []), current, 'the text is the same whatever was accepted');
  assert.deepEqual(pendingHunks([], all), []);
});

test('what was accepted in one version of a file does not carry over to hunks that are not the same', () => {
  const baseline = numbered(30);
  const before = diffFile(baseline.join(''), withLine(baseline, 5, 'X\n').join(''));
  const marks = acceptHunks(new Set(), before.hunks);
  const after = diffFile(baseline.join(''), withLine(baseline, 5, 'Y\n').join(''));
  assert.deepEqual(pendingHunks(after.hunks, marks).map((hunk) => hunk.index), [0], 'another text in the same place');
  const elsewhere = diffFile(baseline.join(''), withLine(baseline, 6, 'X\n').join(''));
  assert.deepEqual(pendingHunks(elsewhere.hunks, marks).map((hunk) => hunk.index), [0], 'the same text in another place');
});

// ---- the types of a source of review ---------------------------------------------------------------------------------------------------------

test('the types of a source of review are types only: the module has nothing to run', () => {
  assert.deepEqual(Object.keys(sourceTypes), []);
});
