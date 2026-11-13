// The line diff behind the approval card (P8 ux-7): which lines a write or an edit would add and take away, grouped into hunks with three lines of context, in the same rows
// the Review tab shows (ui/src/lib/review-hunks.ts). The Hub has no runtime dependency, so this is a Myers search of its own, bounded so that no file can hold the event loop.
//
// A text is cut into lines that keep their own terminator (a CRLF, a missing final newline, a lone CR inside a line all come through exactly), the lines of the two texts are
// compared, and the changes are grouped: two changes with six unchanged lines or fewer between them (the context of both would touch) are one hunk. Nothing here touches a file.
import { createHash } from 'node:crypto';

export const CONTEXT_LINES = 3;
/** The search for the changes gives up past this many lines added plus lines taken away; the changes then become one hunk, still exact. Same limit as the Review tab. */
export const MAX_EDIT_LENGTH = 1000;
/** The search also gives up after this many steps (every diagonal it opens and every line it compares), so that repeated lines cannot make it slow. */
export const MAX_DIFF_STEPS = 4_000_000;
const MERGE_GAP = 2 * CONTEXT_LINES;
const BYTE_ORDER_MARK = 0xfeff;

/** Cuts a text after every line feed. A carriage return alone does not end a line, and a last line without a terminator is a line. */
export function splitLines(text) {
  const lines = [];
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf('\n', start);
    if (end === -1) {
      lines.push(text.slice(start));
      break;
    }
    lines.push(text.slice(start, end + 1));
    start = end + 1;
  }
  return lines;
}

/**
 * The shortest script (Myers, O(ND)) that turns `a` into `b`, as blocks: lines [aStart, aEnd) of `a` are replaced by lines [bStart, bEnd) of `b`. Null when the script is longer than
 * MAX_EDIT_LENGTH or the search took more than MAX_DIFF_STEPS.
 */
function search(a, b) {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, MAX_EDIT_LENGTH);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace = [];
  let steps = 0;
  for (let d = 0; d <= limit; d += 1) {
    // What the furthest reaching paths looked like before this round, for the walk back.
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; steps += 1; }
      steps += 1;
      v[offset + k] = x;
      if (x >= n && y >= m) return blocksFrom(trace, n, m);
    }
    if (steps > MAX_DIFF_STEPS) return null;
  }
  return null;
}

/** Walks the trace back from the end of both lists and turns the moves into blocks of changed lines. */
function blocksFrom(trace, n, m) {
  const moves = []; // from the end to the start: 0 equal line, -1 line taken away, 1 line put in
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const before = trace[d];
    const reach = (k) => before[k + d + 1];
    const k = x - y;
    const previousK = k === -d || (k !== d && reach(k - 1) < reach(k + 1)) ? k + 1 : k - 1;
    const previousX = reach(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) { moves.push(0); x -= 1; y -= 1; }
    if (d > 0) moves.push(x === previousX ? 1 : -1);
    x = previousX;
    y = previousY;
  }
  const blocks = [];
  let open = null;
  let at = 0;
  let to = 0;
  for (let index = moves.length - 1; index >= 0; index -= 1) {
    const move = moves[index];
    if (move === 0) {
      if (open) { blocks.push(open); open = null; }
      at += 1; to += 1;
      continue;
    }
    open ??= { aStart: at, aEnd: at, bStart: to, bEnd: to };
    if (move < 0) { at += 1; open.aEnd = at; } else { to += 1; open.bEnd = to; }
  }
  if (open) blocks.push(open);
  return blocks;
}

/** Where two lists of lines differ: ordered blocks of lines taken away from `a` and lines put in their place in `b`. */
function changeBlocks(a, b) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const aEnd = a.length - tail;
  const bEnd = b.length - tail;
  if (head === aEnd && head === bEnd) return [];
  const everything = { aStart: head, aEnd, bStart: head, bEnd };
  if (head === aEnd || head === bEnd) return [everything];
  const found = search(a.slice(head, aEnd), b.slice(head, bEnd));
  // Too far apart to be worth searching: from the first changed line to the last is one change. The text is still exact.
  if (!found) return [everything];
  return found.map((block) => ({ aStart: block.aStart + head, aEnd: block.aEnd + head, bStart: block.bStart + head, bEnd: block.bEnd + head }));
}

/** Blocks close enough for their context to touch go together. */
function groupBlocks(blocks) {
  const groups = [];
  for (const block of blocks) {
    const group = groups[groups.length - 1];
    if (group && block.aStart - group[group.length - 1].aEnd <= MERGE_GAP) group.push(block);
    else groups.push([block]);
  }
  return groups;
}

/** What a line says once its terminator and a leading byte order mark are put aside. */
function visibleText(line) {
  const text = line.charCodeAt(0) === BYTE_ORDER_MARK ? line.slice(1) : line;
  if (!text.endsWith('\n')) return text;
  return text.slice(0, text.endsWith('\r\n') ? -2 : -1);
}

const contextRows = (lines, from, to) => lines.slice(from, to).map((text) => ({ kind: 'context', text }));

/** One block only: it puts back as many lines as it takes away and each says the same as the one it replaces. */
function looksTheSame(block, baselineLines, currentLines) {
  const gone = baselineLines.slice(block.aStart, block.aEnd).map(visibleText);
  const put = currentLines.slice(block.bStart, block.bEnd).map(visibleText);
  return gone.length === put.length && gone.every((words, at) => words === put[at]);
}

function buildHunk(blocks, baselineLines, currentLines) {
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  const span = [];
  blocks.forEach((block, at) => {
    if (at > 0) span.push(...contextRows(currentLines, blocks[at - 1].bEnd, block.bStart));
    for (let line = block.aStart; line < block.aEnd; line += 1) span.push({ kind: 'removed', text: baselineLines[line] });
    for (let line = block.bStart; line < block.bEnd; line += 1) span.push({ kind: 'added', text: currentLines[line] });
  });
  // Context before the first changed line cannot start below line 0; context after is cut off by the end of the file.
  const before = Math.min(CONTEXT_LINES, first.bStart);
  return {
    baselineStart: first.aStart,
    baselineEnd: last.aEnd,
    currentStart: first.bStart,
    currentEnd: last.bEnd,
    removed: blocks.reduce((total, block) => total + block.aEnd - block.aStart, 0),
    added: blocks.reduce((total, block) => total + block.bEnd - block.bStart, 0),
    invisibleOnly: blocks.every((block) => looksTheSame(block, baselineLines, currentLines)),
    rows: [...contextRows(currentLines, first.bStart - before, first.bStart), ...span, ...contextRows(currentLines, last.bEnd, last.bEnd + CONTEXT_LINES)],
  };
}

/**
 * The hunks that turn `baseline` into `current`, and how many lines they add and take away. Total: any two strings give a result, and the same two strings always give the same one.
 * @returns {{hunks: {baselineStart: number, baselineEnd: number, currentStart: number, currentEnd: number, removed: number, added: number, invisibleOnly: boolean, rows: {kind: 'context'|'removed'|'added', text: string}[]}[], additions: number, deletions: number}}
 */
export function diffHunks(baseline, current) {
  const baselineLines = splitLines(baseline);
  const currentLines = splitLines(current);
  const hunks = groupBlocks(changeBlocks(baselineLines, currentLines)).map((blocks) => buildHunk(blocks, baselineLines, currentLines));
  return { hunks, additions: hunks.reduce((total, hunk) => total + hunk.added, 0), deletions: hunks.reduce((total, hunk) => total + hunk.removed, 0) };
}

/**
 * sha256 of the hunks, written as: for each hunk its four numbers, then every row as its kind, its length and its text (so that rows which run together cannot be taken for other
 * rows); hunks are separated by NUL. Two changes with the same digest are the same change, row by row.
 */
export function hunksDigest(hunks) {
  const written = hunks.map((hunk) => `@${hunk.baselineStart},${hunk.baselineEnd},${hunk.currentStart},${hunk.currentEnd}\n${hunk.rows.map((row) => `${row.kind[0]}${row.text.length}:${row.text}`).join('')}`).join('\u0000');
  return createHash('sha256').update(written).digest('hex');
}
