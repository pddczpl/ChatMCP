// The model of the Review tab, without a page: a text is cut into lines that keep their own terminator, the lines of two versions are compared, the changes are grouped
// into hunks with three lines of context, and a hunk can be undone. A text is put together again by concatenating the original lines, never by joining them with a
// line feed, so CRLF, a missing final newline and a leading byte order mark come back exactly as they were. Nothing here throws and nothing here touches the page.
import { diffArrays } from 'diff';
import type { ArrayChange } from 'diff';

export const CONTEXT_LINES = 3;
/** The search for the changes gives up past this many lines added plus lines taken away; the changes then become one hunk. */
export const MAX_EDIT_LENGTH = 1000;
/** Two changes with this many unchanged lines or fewer between them (the context of both would touch) are one hunk. */
const MERGE_GAP = 2 * CONTEXT_LINES;
/** U+FEFF at the start of a file is its byte order mark; it stays inside the first line like any other character. */
const BYTE_ORDER_MARK = 0xfeff;

export type RowKind = 'context' | 'removed' | 'added';
export interface DiffRow { kind: RowKind; text: string }

export interface Hunk {
  /** Its place in FileDiff.hunks: the number rejectHunk takes. */
  index: number;
  /** The change replaces baselineLines[baselineStart, baselineEnd) with currentLines[currentStart, currentEnd); the context is not counted. */
  baselineStart: number;
  baselineEnd: number;
  currentStart: number;
  currentEnd: number;
  removed: number;
  added: number;
  /** Only line endings or a byte order mark differ: every block of the hunk puts back as many lines as it takes away, and each says the same as the line it replaces. */
  invisibleOnly: boolean;
  /** Sixteen hex digits that tell this hunk from the others of its file: what it changes, and where in the baseline. */
  fingerprint: string;
  /** Up to three lines of context, the changed lines (and the unchanged lines between them), up to three lines of context. */
  rows: DiffRow[];
}

export interface FileDiff { baselineLines: string[]; currentLines: string[]; hunks: Hunk[] }

/** Cuts a text after every line feed. A carriage return alone does not end a line, and a last line without a terminator is a line. */
export const splitLines = (text: string): string[] => {
  const lines: string[] = [];
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
};

export const joinLines = (lines: readonly string[]): string => lines.join('');

interface Block { aStart: number; aEnd: number; bStart: number; bEnd: number }

/** Where two lists of lines differ: ordered blocks of lines taken away from `a` and lines put in their place in `b`. */
const changeBlocks = (a: readonly string[], b: readonly string[]): Block[] => {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const aEnd = a.length - tail;
  const bEnd = b.length - tail;
  if (head === aEnd && head === bEnd) return [];
  const everything: Block = { aStart: head, aEnd, bStart: head, bEnd };
  if (head === aEnd || head === bEnd) return [everything];
  const parts: ArrayChange<string>[] | undefined = diffArrays(a.slice(head, aEnd), b.slice(head, bEnd), { maxEditLength: MAX_EDIT_LENGTH });
  // Too far apart to be worth searching: from the first changed line to the last is one change. The bytes are still exact.
  if (!parts) return [everything];
  const blocks: Block[] = [];
  let open: Block | null = null;
  let at = head;
  let to = head;
  for (const part of parts) {
    const count = part.value.length;
    if (!part.added && !part.removed) {
      if (open) { blocks.push(open); open = null; }
      at += count; to += count;
    } else {
      open ??= { aStart: at, aEnd: at, bStart: to, bEnd: to };
      if (part.removed) { at += count; open.aEnd = at; } else { to += count; open.bEnd = to; }
    }
  }
  if (open) blocks.push(open);
  return blocks;
};

/** Blocks close enough for their context to touch go together. */
const groupBlocks = (blocks: readonly Block[]): Block[][] => {
  const groups: Block[][] = [];
  for (const block of blocks) {
    const group = groups[groups.length - 1];
    if (group && block.aStart - group[group.length - 1].aEnd <= MERGE_GAP) group.push(block);
    else groups.push([block]);
  }
  return groups;
};

/** What a line says once its terminator and a leading byte order mark are put aside. */
const visibleText = (line: string): string => {
  const text = line.charCodeAt(0) === BYTE_ORDER_MARK ? line.slice(1) : line;
  if (!text.endsWith('\n')) return text;
  return text.slice(0, text.endsWith('\r\n') ? -2 : -1);
};

const contextRows = (lines: readonly string[], from: number, to: number): DiffRow[] => lines.slice(from, to).map((text) => ({ kind: 'context', text }));

const wordsOf = (lines: readonly string[], from: number, to: number): string[] => lines.slice(from, to).map(visibleText);

/** One block only: it puts back as many lines as it takes away and each says the same as the one it replaces. Pairing lines across blocks would take a moved line for the same one. */
const looksTheSame = (block: Block, baselineLines: readonly string[], currentLines: readonly string[]): boolean => {
  const gone = wordsOf(baselineLines, block.aStart, block.aEnd);
  const put = wordsOf(currentLines, block.bStart, block.bEnd);
  return gone.length === put.length && gone.every((words, at) => words === put[at]);
};

const buildHunk = (blocks: readonly Block[], index: number, baselineLines: readonly string[], currentLines: readonly string[]): Hunk => {
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  const span: DiffRow[] = [];
  blocks.forEach((block, at) => {
    if (at > 0) span.push(...contextRows(currentLines, blocks[at - 1].bEnd, block.bStart));
    for (let line = block.aStart; line < block.aEnd; line += 1) span.push({ kind: 'removed', text: baselineLines[line] });
    for (let line = block.bStart; line < block.bEnd; line += 1) span.push({ kind: 'added', text: currentLines[line] });
  });
  // Context before the first changed line cannot start below line 0 (a negative start would count from the end); context after is cut off by the end of the file.
  const before = Math.min(CONTEXT_LINES, first.bStart);
  return {
    index,
    baselineStart: first.aStart,
    baselineEnd: last.aEnd,
    currentStart: first.bStart,
    currentEnd: last.bEnd,
    removed: blocks.reduce((total, block) => total + block.aEnd - block.aStart, 0),
    added: blocks.reduce((total, block) => total + block.bEnd - block.bStart, 0),
    invisibleOnly: blocks.every((block) => looksTheSame(block, baselineLines, currentLines)),
    // Every row is written with its kind and its length, so that lines which run together when written out cannot be mistaken for other lines.
    fingerprint: hashText(`${first.aStart}:${span.map((row) => `${row.kind[0]}${row.text.length}:${row.text}`).join('')}`),
    rows: [...contextRows(currentLines, first.bStart - before, first.bStart), ...span, ...contextRows(currentLines, last.bEnd, last.bEnd + CONTEXT_LINES)],
  };
};

/** The hunks that turn the baseline into the current text. Total: any two strings give a result. */
export const diffFile = (baseline: string, current: string): FileDiff => {
  const baselineLines = splitLines(baseline);
  const currentLines = splitLines(current);
  const hunks = groupBlocks(changeBlocks(baselineLines, currentLines)).map((blocks, index) => buildHunk(blocks, index, baselineLines, currentLines));
  return { baselineLines, currentLines, hunks };
};

/** The current text with the chosen hunks put back as the baseline had them. An index that is not a hunk of the file is ignored. */
export const rejectHunks = (diff: FileDiff, which: Iterable<number>): string => {
  const chosen = new Set(which);
  const pieces: string[] = [];
  let from = 0;
  for (const hunk of diff.hunks) {
    if (!chosen.has(hunk.index)) continue;
    pieces.push(diff.currentLines.slice(from, hunk.currentStart).join(''), diff.baselineLines.slice(hunk.baselineStart, hunk.baselineEnd).join(''));
    from = hunk.currentEnd;
  }
  pieces.push(diff.currentLines.slice(from).join(''));
  return pieces.join('');
};

export const rejectHunk = (diff: FileDiff, index: number): string => rejectHunks(diff, [index]);

export const rejectAll = (diff: FileDiff): string => rejectHunks(diff, diff.hunks.map((hunk) => hunk.index));

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

/** FNV-1a over the UTF-16 units of the text, 64 bits, as sixteen hex digits. Not a secret: it only has to tell texts apart. */
export const hashText = (text: string): string => {
  let hash = FNV_OFFSET;
  for (let at = 0; at < text.length; at += 1) hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(at))) * FNV_PRIME);
  return hash.toString(16).padStart(16, '0');
};

/** A hunk is accepted by its fingerprint. The set that was given is never changed; when nothing is new, the very same set comes back. */
export const acceptHunk = (accepted: ReadonlySet<string>, hunk: Hunk): ReadonlySet<string> => (accepted.has(hunk.fingerprint) ? accepted : new Set(accepted).add(hunk.fingerprint));

export const acceptHunks = (accepted: ReadonlySet<string>, hunks: readonly Hunk[]): ReadonlySet<string> => hunks.reduce(acceptHunk, accepted);

export const pendingHunks = (hunks: readonly Hunk[], accepted: ReadonlySet<string>): Hunk[] => hunks.filter((hunk) => !accepted.has(hunk.fingerprint));
