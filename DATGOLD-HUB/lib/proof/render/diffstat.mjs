// The diff stat of a report (docs/PROOF-RENDER.md, "Diff stat"): files, lines added and removed, counted from the patch of the pack itself.
//
// The patch can come from anyone, and a count that misses a file is worse than none. So this reads exactly the form `pack` writes (`git diff`
// with DIFF_ARGS of ../baseline.mjs: no renames, a/ and b/, full index lines, binary patches) and nothing else: the counts of a hunk are
// taken from its header and every line of it is accounted for, so a line of a hunk that looks like a header stays a line; a name must be the
// same wherever it stands. A patch with anything outside that form has no counts (null).

/** How many files are listed; the totals count all of them. */
export const DIFF_ROWS = 2000;
/** The longest name read, as it stands in the patch (a path of 4,096 bytes, every byte an octal escape). */
const NAME_CHARS = 4 * 4096 + 8;

const ESCAPES = Object.freeze({ a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 });
const HUNK = /^@@ -[0-9]{1,9}(?:,([0-9]{1,9}))? \+[0-9]{1,9}(?:,([0-9]{1,9}))? @@(?: |$)/;
const BLOCK = /^(?:literal|delta) [0-9]{1,12}$/;
const DATA = /^[A-Za-z][0-9A-Za-z!#$%&()*+;<=>?@^_`{|}~-]+$/;
const NO_NEWLINE = '\\ No newline at end of file';

/** The bytes (as latin1 text) of a name quoted as Git quotes it, or null. */
function unquote(quoted) {
  const body = /^"((?:[^"\\]|\\.)*)"$/.exec(quoted)?.[1];
  if (body === undefined) return null;
  let bad = false;
  const bytes = body.replace(/\\([0-3][0-7]{2}|.)/g, (_, escape) => {
    if (escape.length === 3) return String.fromCharCode(parseInt(escape, 8));
    if (!Object.hasOwn(ESCAPES, escape)) bad = true;
    return String.fromCharCode(ESCAPES[escape]);
  });
  return bad ? null : bytes;
}

/** A name of the patch without its `prefix` (a/ or b/), as latin1 text; null when it is not one. */
function nameOf(value, prefix) {
  if (value.length > NAME_CHARS) return null;
  const raw = value.startsWith('"') ? unquote(value) : value;
  return raw !== null && raw.startsWith(prefix) ? raw.slice(prefix.length) : null;
}

/** The one name of `diff --git a/<name> b/<name>`: both halves are the same name, so there is one way to split the line. */
function headName(line) {
  const rest = line.slice('diff --git '.length);
  const left = rest.slice(0, (rest.length - 1) / 2);
  const right = rest.slice((rest.length + 1) / 2);
  const name = nameOf(left, 'a/');
  return name !== null && rest === `${left} ${right}` && name === nameOf(right, 'b/') ? name : null;
}

/** Reads the lines of a patch one by one (latin1: one character per byte). */
class Lines {
  constructor(bytes) {
    this.text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
    this.at = 0;
  }

  get done() { return this.at >= this.text.length; }

  /** The next line without its line end, or null when there is none (the last line must end too). */
  peek() {
    const end = this.text.indexOf('\n', this.at);
    return end < 0 ? null : this.text.slice(this.at, end);
  }

  take() {
    const line = this.peek();
    if (line !== null) this.at += line.length + 1;
    return line;
  }
}

/** One hunk: every line its header counts. False when a line is missing, of another kind or too many. */
function hunk(lines, file) {
  const match = HUNK.exec(lines.take());
  if (!match) return false;
  let before = match[1] === undefined ? 1 : Number(match[1]);
  let after = match[2] === undefined ? 1 : Number(match[2]);
  while (before > 0 || after > 0) {
    const line = lines.take();
    if (line === null) return false;
    if (line[0] === ' ') { before -= 1; after -= 1; }
    else if (line[0] === '-') { before -= 1; file.removed += 1; }
    else if (line[0] === '+') { after -= 1; file.added += 1; }
    else if (line !== NO_NEWLINE) return false;
  }
  if (lines.peek() === NO_NEWLINE) lines.take();
  return before === 0 && after === 0;
}

/** The blocks of a binary patch (the new bytes, then the old ones); false when there is none or one is not whole. */
function binaryBlocks(lines) {
  let blocks = 0;
  while (BLOCK.test(lines.peek() ?? '')) {
    lines.take();
    let rows = 0;
    while (DATA.test(lines.peek() ?? '')) { lines.take(); rows += 1; }
    if (!rows || lines.take() !== '') return false;
    blocks += 1;
  }
  return blocks > 0;
}

/** One file of the patch, or null. */
function fileOf(lines) {
  const head = lines.take();
  if (head === null || !head.startsWith('diff --git ')) return null;
  const name = headName(head);
  if (name === null) return null;
  const file = { path: Buffer.from(name, 'latin1').toString('utf8'), change: 'modified', added: 0, removed: 0, binary: false };
  for (;;) {
    const line = lines.peek() ?? '';
    const kind = /^(new file|deleted file|old|new) mode [0-7]{6}$/.exec(line)?.[1];
    if (kind === 'new file' || kind === 'deleted file') {
      if (file.change !== 'modified') return null;
      file.change = kind === 'new file' ? 'added' : 'deleted';
    } else if (!kind && !/^index [0-9a-f]{40,64}\.\.[0-9a-f]{40,64}(?: [0-7]{6})?$/.test(line)) break;
    lines.take();
  }
  const next = lines.peek() ?? '';
  if (next === 'GIT binary patch') {
    lines.take();
    file.binary = true;
    return binaryBlocks(lines) ? file : null;
  }
  if (!next.startsWith('--- ')) return file;
  // the two names: /dev/null exactly where the head says so, else the name of the head (a name with a space ends with a tab)
  const sides = [['--- ', 'a/', 'added'], ['+++ ', 'b/', 'deleted']];
  for (const [mark, prefix, absent] of sides) {
    const line = lines.take() ?? '';
    if (!line.startsWith(mark)) return null;
    const value = line.slice(mark.length).replace(/\t$/, '');
    if (file.change === absent ? value !== '/dev/null' : nameOf(value, prefix) !== name) return null;
  }
  let hunks = 0;
  while ((lines.peek() ?? '').startsWith('@@')) {
    if (!hunk(lines, file)) return null;
    hunks += 1;
  }
  return hunks > 0 ? file : null;
}

/**
 * {files: [{path, change (added, modified, deleted), added, removed, binary}] (the first DIFF_ROWS), total, added, removed, binary} of a
 * patch (its bytes), or null when it holds anything but the form above.
 */
export function diffStat(patch) {
  const lines = new Lines(patch);
  const stat = { files: [], total: 0, added: 0, removed: 0, binary: 0 };
  while (!lines.done) {
    const file = fileOf(lines);
    if (file === null) return null;
    if (stat.files.length < DIFF_ROWS) stat.files.push(file);
    stat.total += 1;
    stat.added += file.added;
    stat.removed += file.removed;
    if (file.binary) stat.binary += 1;
  }
  return stat;
}
