// The patch engine (plan task multi-agent-tools-20, docs/PATCH-ENGINE.md): parse a unified diff or the `*** Begin Patch` envelope, and work out the
// new text of every file it touches. Pure functions: no import, no file, no process, no clock. The caller reads the files and hands their text in;
// the engine hands back what to write and what to delete, or one refusal that names the file and the hunk. Nothing calls it yet; the apply_patch
// tool (multi-agent-tools-21) will wrap it with the I/O, the checkpoint, the permissions and the receipts.
//
// Fail closed: a hunk is placed where all of its old lines match, at the lowest rung of the fuzz ladder that finds a place, and only where that
// place is the one the diff names or the only one. Two places, no place, or a hunk that would be placed with no line to match is a refusal.

/** Upper bounds of one call. A caller may lower them (options.limits); a higher value than these is ignored. */
export const PATCH_LIMITS = Object.freeze({
  maxPatchBytes: 8 * 1024 * 1024,
  maxFiles: 1000,
  maxHunks: 10000,
  maxFileBytes: 32 * 1024 * 1024,
  maxPathLength: 4096,
  maxSearchSteps: 100_000_000, // lines compared while placing the hunks of one file
});

/** The rungs of the fuzz ladder, in the order they are tried. The index of a rung is the `fuzz` a hunk report gives. */
export const FUZZ_LEVELS = Object.freeze(['exact', 'trailing-whitespace', 'trimmed', 'unicode-punctuation']);

export class PatchError extends Error {
  /**
   * @param {string} code one of: too_large, too_many_files, too_many_hunks, malformed, empty, binary, unsafe_path, unsupported_mode, file_exists,
   *   file_missing, context_mismatch, ambiguous, no_context, not_at_eof, delete_not_empty
   */
  constructor(code, message, { file = null, hunk = null } = {}) {
    super(message);
    this.name = 'PatchError';
    this.code = code;
    this.file = file;
    this.hunk = hunk;
  }
}

function limitsOf(options) {
  const out = { ...PATCH_LIMITS };
  const asked = options?.limits ?? {};
  for (const key of Object.keys(PATCH_LIMITS)) {
    const value = asked[key];
    if (Number.isSafeInteger(value) && value >= 0 && value < out[key]) out[key] = value;
  }
  return out;
}

/** UTF-8 length of a string without encoding it (lone surrogates count as the 3 bytes of U+FFFD). */
function utf8Length(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { bytes += 4; i += 1; }
    else bytes += 3;
  }
  return bytes;
}

// ------------------------------------------------------------------ paths

const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;

/**
 * Returns the path unchanged when it is a safe relative path inside the root, or throws PatchError('unsafe_path'). Separators are `/` only. Refused:
 * empty, too long, absolute, a drive letter or any colon, a backslash, NUL or another control character, an empty, `.` or `..` segment, a `.git`
 * segment (or its 8.3 short name), a Windows device name, a segment that ends in a dot or a space (Windows drops them, so two names would be one).
 */
export function checkPatchPath(value, { limits } = {}) {
  const max = limits?.maxPathLength ?? PATCH_LIMITS.maxPathLength;
  const refuse = (why) => { throw new PatchError('unsafe_path', `unsafe path ${JSON.stringify(typeof value === 'string' ? value.slice(0, 200) : value)}: ${why}`, { file: typeof value === 'string' ? value : null }); };
  if (typeof value !== 'string' || value.length === 0) refuse('not a file name');
  if (value.length > max) refuse(`longer than ${max} characters`);
  if (/[\u0000-\u001f\u007f]/.test(value)) refuse('it holds a control character');
  if (value.includes('\\')) refuse('a backslash; use / between folders');
  if (value.includes(':')) refuse('a drive letter or a colon');
  if (value.startsWith('/')) refuse('an absolute path');
  for (const segment of value.split('/')) {
    if (segment === '') refuse('an empty folder name (a leading, doubled or trailing /)');
    if (segment === '.' || segment === '..') refuse(`a "${segment}" segment`);
    if (/^\.git$/i.test(segment) || /^git~\d+$/i.test(segment)) refuse('it writes into .git');
    if (DEVICE_NAME.test(segment)) refuse('a Windows device name');
    if (/[. ]$/.test(segment)) refuse('a name that ends in a dot or a space');
  }
  return value;
}

/** Decodes a name git wrote in C-style quotes ("a/na\303\257ve"): \a \b \t \n \v \f \r \" \\ and octal bytes, read as UTF-8. */
function unquoteGitName(text, at) {
  // text[at] is the opening quote; returns { name, end } with end just after the closing quote.
  const bytes = [];
  let i = at + 1;
  const pushText = (s) => { for (const b of encodeUtf8(s)) bytes.push(b); };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') return { name: decodeUtf8(bytes), end: i + 1 };
    if (ch === '\\') {
      const next = text[i + 1];
      const simple = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }[next];
      if (simple !== undefined) { bytes.push(simple); i += 2; continue; }
      if (/^[0-3][0-7]{2}$/.test(text.slice(i + 1, i + 4))) { bytes.push(parseInt(text.slice(i + 1, i + 4), 8)); i += 4; continue; }
      throw new PatchError('malformed', `a quoted file name with an unknown escape: ${text.slice(at, i + 2)}`);
    }
    pushText(ch);
    i += 1;
  }
  throw new PatchError('malformed', `a quoted file name without its closing quote: ${text.slice(at, at + 80)}`);
}

function encodeUtf8(s) {
  const out = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return out;
}

function decodeUtf8(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    const need = b < 0x80 ? 0 : (b & 0xe0) === 0xc0 ? 1 : (b & 0xf0) === 0xe0 ? 2 : (b & 0xf8) === 0xf0 ? 3 : -1;
    if (need < 0 || i + need >= bytes.length) throw new PatchError('malformed', 'a quoted file name that is not UTF-8');
    let cp = need === 0 ? b : b & (0x3f >> need);
    for (let k = 1; k <= need; k += 1) {
      const c = bytes[i + k];
      if ((c & 0xc0) !== 0x80) throw new PatchError('malformed', 'a quoted file name that is not UTF-8');
      cp = (cp << 6) | (c & 63);
    }
    const min = [0, 0x80, 0x800, 0x10000][need];
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new PatchError('malformed', 'a quoted file name that is not UTF-8');
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}

// ------------------------------------------------------------------ parsing: shared

/** Splits text on LF only. Each line keeps a trailing CR as a flag: { text, cr }. The last segment after a final LF is dropped. */
function splitPatchLines(text) {
  const raw = text.split('\n');
  if (raw.length && raw[raw.length - 1] === '') raw.pop();
  return raw;
}

const stripCr = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line);

/**
 * Parses a patch. Returns { format: 'unified' | 'envelope', files: FilePatch[] } or throws PatchError.
 * FilePatch: { kind: 'modify' | 'add' | 'delete' | 'rename' | 'copy', oldPath, newPath, oldMode, newMode, format, hunks: Hunk[] }
 * Hunk: { header, oldStart, oldCount, newStart, newCount, anchors, endOfFile, oldNoEol, newNoEol, lines: { op: ' ' | '-' | '+', text, cr }[] }
 * options: { limits, checkPaths = true }
 */
export function parsePatch(text, options = {}) {
  const limits = limitsOf(options);
  if (typeof text !== 'string') throw new PatchError('malformed', 'the patch is not text');
  if (text.length > limits.maxPatchBytes || utf8Length(text) > limits.maxPatchBytes) {
    throw new PatchError('too_large', `the patch is larger than ${limits.maxPatchBytes} bytes`);
  }
  if (text.includes('\0')) throw new PatchError('binary', 'the patch holds a NUL byte: binary content is not applied');
  const firstLine = text.replace(/^[\s]*/, '').split('\n', 1)[0];
  const parsed = stripCr(firstLine).trimEnd() === '*** Begin Patch' ? parseEnvelope(text) : parseUnified(text);
  if (parsed.files.length === 0) throw new PatchError('empty', 'no file change was found in the patch (expected a unified diff or a *** Begin Patch envelope)');
  if (parsed.files.length > limits.maxFiles) throw new PatchError('too_many_files', `the patch changes ${parsed.files.length} files, more than ${limits.maxFiles}`);
  const hunks = parsed.files.reduce((sum, file) => sum + file.hunks.length, 0);
  if (hunks > limits.maxHunks) throw new PatchError('too_many_hunks', `the patch has ${hunks} hunks, more than ${limits.maxHunks}`);
  if (options.checkPaths !== false) {
    for (const file of parsed.files) {
      if (file.oldPath !== null) checkPatchPath(file.oldPath, { limits });
      if (file.newPath !== null) checkPatchPath(file.newPath, { limits });
    }
  }
  return parsed;
}

/** The paths a caller must read (their text or null when missing) and the paths the patch may write or delete, each once, in order. */
export function patchPaths(parsed) {
  const reads = [];
  const writes = [];
  const add = (list, p) => { if (p !== null && !list.includes(p)) list.push(p); };
  for (const file of parsed.files) {
    add(reads, file.oldPath); add(reads, file.newPath);
    if (file.kind !== 'copy') add(writes, file.oldPath);
    add(writes, file.newPath);
  }
  return { reads, writes };
}

// ------------------------------------------------------------------ parsing: unified diffs

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const MODE = /^[0-7]{6}$/;

function checkMode(mode, where) {
  if (!MODE.test(mode)) throw new PatchError('malformed', `${where}: "${mode}" is not a file mode`);
  if (mode === '120000') throw new PatchError('unsupported_mode', `${where}: a symbolic link (mode 120000) is not applied; only regular text files are`);
  if (mode === '160000') throw new PatchError('unsupported_mode', `${where}: a submodule (mode 160000) is not applied; only regular text files are`);
  if (mode !== '100644' && mode !== '100755') throw new PatchError('malformed', `${where}: mode ${mode} is not one git writes for a file`);
  return mode;
}

/** A name from a ---/+++ line: quoted or plain (a plain name ends at a TAB, which starts a timestamp). '/dev/null' stays as it is. */
function headerName(rest) {
  if (rest.startsWith('"')) {
    const { name, end } = unquoteGitName(rest, 0);
    if (rest.slice(end).trim() !== '' && !rest.slice(end).startsWith('\t')) throw new PatchError('malformed', `text after a quoted file name: ${rest.slice(0, 120)}`);
    return name;
  }
  const tab = rest.indexOf('\t');
  const name = tab >= 0 ? rest.slice(0, tab) : rest.replace(/\s+$/, '');
  if (name === '') throw new PatchError('malformed', 'a ---/+++ line without a file name');
  return name;
}

/** The two names of a `diff --git` line. Unquoted names that hold spaces are split where both halves name the same file. */
function gitHeaderNames(rest) {
  const readOne = (at) => {
    if (rest[at] === '"') return unquoteGitName(rest, at);
    return null;
  };
  if (rest.startsWith('"')) {
    const first = readOne(0);
    const tail = rest.slice(first.end);
    if (!tail.startsWith(' ')) throw new PatchError('malformed', `a diff --git line that cannot be read: ${rest.slice(0, 120)}`);
    const second = tail[1] === '"' ? unquoteGitName(tail, 1).name : tail.slice(1);
    return [first.name, second];
  }
  const quotedSecond = rest.indexOf(' "');
  if (quotedSecond > 0 && rest.endsWith('"')) return [rest.slice(0, quotedSecond), unquoteGitName(rest, quotedSecond + 1).name];
  // a/X b/X: try every " b/" split and keep the one whose halves name the same file.
  for (let i = rest.indexOf(' '); i >= 0; i = rest.indexOf(' ', i + 1)) {
    const a = rest.slice(0, i);
    const b = rest.slice(i + 1);
    if (stripPrefix(a, 'a/') === stripPrefix(b, 'b/')) return [a, b];
  }
  return null;
}

const stripPrefix = (name, prefix) => (name.startsWith(prefix) ? name.slice(prefix.length) : name);

function parseUnified(text) {
  const lines = splitPatchLines(text);
  const files = [];
  let i = 0;
  const isGitStart = (line) => line.startsWith('diff --git ');
  const isPlainStart = (k) => lines[k].startsWith('--- ') && k + 1 < lines.length && lines[k + 1].startsWith('+++ ');
  while (i < lines.length) {
    if (isGitStart(lines[i])) { i = parseGitSection(lines, i, files); continue; }
    if (isPlainStart(i)) { i = parsePlainSection(lines, i, files); continue; }
    if (HUNK_HEADER.test(lines[i])) throw new PatchError('malformed', `a hunk (${lines[i].slice(0, 80)}) before any file header`);
    i += 1; // text around the diff (an e-mail, a commit message, a diffstat) is ignored, as git does
  }
  return { format: 'unified', files };
}

function parseGitSection(lines, start, files) {
  const header = lines[start];
  const names = gitHeaderNames(stripCr(header).slice('diff --git '.length));
  const section = { kind: 'modify', oldPath: null, newPath: null, oldMode: null, newMode: null, format: 'unified', hunks: [] };
  let renameFrom = null; let renameTo = null; let copyFrom = null; let copyTo = null;
  let isNew = false; let isDeleted = false;
  let i = start + 1;
  let minus = null; let plus = null;
  for (; i < lines.length; i += 1) {
    const line = stripCr(lines[i]);
    let m;
    if ((m = /^old mode (\S+)$/.exec(line))) section.oldMode = checkMode(m[1], 'old mode');
    else if ((m = /^new mode (\S+)$/.exec(line))) section.newMode = checkMode(m[1], 'new mode');
    else if ((m = /^new file mode (\S+)$/.exec(line))) { isNew = true; section.newMode = checkMode(m[1], 'new file mode'); }
    else if ((m = /^deleted file mode (\S+)$/.exec(line))) { isDeleted = true; section.oldMode = checkMode(m[1], 'deleted file mode'); }
    else if (line.startsWith('rename from ')) renameFrom = headerName(line.slice(12));
    else if (line.startsWith('rename to ')) renameTo = headerName(line.slice(10));
    else if (line.startsWith('copy from ')) copyFrom = headerName(line.slice(10));
    else if (line.startsWith('copy to ')) copyTo = headerName(line.slice(8));
    else if (/^(dis)?similarity index \d+%$/.test(line)) { /* informational */ }
    else if ((m = /^index [0-9a-f]+\.\.[0-9a-f]+(?: (\S+))?$/.exec(line))) {
      if (m[1]) { const mode = checkMode(m[1], 'index line'); section.oldMode ??= mode; section.newMode ??= mode; }
    } else if (line === 'GIT binary patch' || /^Binary files .* differ$/.test(line)) {
      throw new PatchError('binary', `${describeNames(names, renameTo)}: a binary patch is not applied; only text changes are`, { file: names ? stripPrefix(names[1], 'b/') : null });
    } else if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      minus = headerName(line.slice(4));
      plus = headerName(stripCr(lines[i + 1]).slice(4));
      i += 2;
      break;
    } else break;
  }
  const oldName = minus !== null ? (minus === '/dev/null' ? null : stripPrefix(minus, 'a/')) : null;
  const newName = plus !== null ? (plus === '/dev/null' ? null : stripPrefix(plus, 'b/')) : null;
  if (minus === '/dev/null') isNew = true;
  if (plus === '/dev/null') isDeleted = true;
  if (isNew && isDeleted) throw new PatchError('malformed', `${header.slice(0, 120)}: a file both created and deleted`);
  const headerOld = names ? stripPrefix(names[0], 'a/') : null;
  const headerNew = names ? stripPrefix(names[1], 'b/') : null;
  if (renameFrom !== null || renameTo !== null) {
    if (renameFrom === null || renameTo === null) throw new PatchError('malformed', `${header.slice(0, 120)}: a rename needs both "rename from" and "rename to"`);
    section.kind = 'rename'; section.oldPath = renameFrom; section.newPath = renameTo;
  } else if (copyFrom !== null || copyTo !== null) {
    if (copyFrom === null || copyTo === null) throw new PatchError('malformed', `${header.slice(0, 120)}: a copy needs both "copy from" and "copy to"`);
    section.kind = 'copy'; section.oldPath = copyFrom; section.newPath = copyTo;
  } else if (isNew) {
    section.kind = 'add'; section.newPath = newName ?? headerNew;
  } else if (isDeleted) {
    section.kind = 'delete'; section.oldPath = oldName ?? headerOld;
  } else {
    section.oldPath = oldName ?? headerOld;
    section.newPath = newName ?? headerNew;
    if (section.oldPath !== section.newPath) throw new PatchError('malformed', `${header.slice(0, 120)}: the old and new names differ without a rename or copy header`);
  }
  if ((section.kind === 'rename' || section.kind === 'copy') && minus !== null && (oldName !== section.oldPath || newName !== section.newPath)) {
    throw new PatchError('malformed', `${header.slice(0, 120)}: the ---/+++ names do not match the ${section.kind} header`);
  }
  if ((section.kind !== 'add' && !section.oldPath) || (section.kind !== 'delete' && !section.newPath)) {
    throw new PatchError('malformed', `${header.slice(0, 120)}: the file names cannot be read`);
  }
  if (minus === null) {
    const modeChange = section.oldMode !== null && section.newMode !== null && section.oldMode !== section.newMode;
    if (section.kind === 'modify' && !modeChange) throw new PatchError('malformed', `${header.slice(0, 120)}: a file header with nothing to change`, { file: section.newPath });
    files.push(section);
    return i;
  }
  const end = parseHunks(lines, i, section);
  files.push(section);
  return end;
}

function describeNames(names, renameTo) {
  if (renameTo) return renameTo;
  return names ? stripPrefix(names[1], 'b/') : 'a file';
}

function parsePlainSection(lines, start, files) {
  const minus = headerName(stripCr(lines[start]).slice(4));
  const plus = headerName(stripCr(lines[start + 1]).slice(4));
  // A plain diff keeps its names as written, without the a/ and b/ that most tools put in front.
  const strip = minus.startsWith('a/') && (plus.startsWith('b/') || plus === '/dev/null') || minus === '/dev/null' && plus.startsWith('b/');
  const oldName = minus === '/dev/null' ? null : strip ? stripPrefix(minus, 'a/') : minus;
  const newName = plus === '/dev/null' ? null : strip ? stripPrefix(plus, 'b/') : plus;
  const section = { kind: 'modify', oldPath: oldName, newPath: newName, oldMode: null, newMode: null, format: 'unified', hunks: [] };
  if (oldName === null && newName === null) throw new PatchError('malformed', 'a diff from /dev/null to /dev/null');
  if (oldName === null) section.kind = 'add';
  else if (newName === null) section.kind = 'delete';
  else if (oldName !== newName) throw new PatchError('malformed', `the old name ${JSON.stringify(oldName)} and the new name ${JSON.stringify(newName)} differ; a rename needs a diff --git header`, { file: newName });
  const end = parseHunks(lines, start + 2, section);
  files.push(section);
  return end;
}

function parseHunks(lines, start, section) {
  const fileName = section.newPath ?? section.oldPath;
  let i = start;
  while (i < lines.length && lines[i].startsWith('@@')) {
    const headerText = stripCr(lines[i]);
    const m = HUNK_HEADER.exec(headerText);
    const number = section.hunks.length + 1;
    const where = `${fileName}, hunk ${number}`;
    if (!m) throw new PatchError('malformed', `${where}: "${headerText.slice(0, 80)}" is not a hunk header (@@ -a,b +c,d @@)`, { file: fileName, hunk: number });
    const nums = [m[1], m[2] ?? '1', m[3], m[4] ?? '1'].map((n) => Number(n));
    if (!nums.every((n) => Number.isSafeInteger(n) && n <= 1e9)) throw new PatchError('malformed', `${where}: a line number out of range`, { file: fileName, hunk: number });
    const [oldStart, oldCount, newStart, newCount] = nums;
    if ((oldCount === 0 && oldStart < 0) || (oldCount > 0 && oldStart < 1) || (newCount > 0 && newStart < 1)) {
      throw new PatchError('malformed', `${where}: a hunk that starts before line 1`, { file: fileName, hunk: number });
    }
    const hunk = { header: headerText, oldStart, oldCount, newStart, newCount, anchors: [], endOfFile: false, oldNoEol: false, newNoEol: false, lines: [] };
    let oldLeft = oldCount;
    let newLeft = newCount;
    i += 1;
    while (oldLeft > 0 || newLeft > 0) {
      if (i >= lines.length) throw new PatchError('malformed', `${where}: the hunk is cut off (${oldLeft} old and ${newLeft} new lines missing)`, { file: fileName, hunk: number });
      const raw = lines[i];
      const op = raw === '' || raw === '\r' ? ' ' : raw[0];
      if (op === '\\') { markNoEol(hunk, where, fileName, number); i += 1; continue; }
      if (op !== ' ' && op !== '-' && op !== '+') throw new PatchError('malformed', `${where}: "${raw.slice(0, 80)}" is not a hunk line (it must start with a space, - or +)`, { file: fileName, hunk: number });
      const body = raw === '' || raw === '\r' ? raw : raw.slice(1);
      const cr = body.endsWith('\r');
      hunk.lines.push({ op, text: cr ? body.slice(0, -1) : body, cr });
      if (op === ' ') { oldLeft -= 1; newLeft -= 1; } else if (op === '-') oldLeft -= 1; else newLeft -= 1;
      if (oldLeft < 0 || newLeft < 0) throw new PatchError('malformed', `${where}: more lines than the header counts`, { file: fileName, hunk: number });
      i += 1;
    }
    if (i < lines.length && lines[i].startsWith('\\')) { markNoEol(hunk, where, fileName, number); i += 1; }
    if (section.kind === 'add' && (oldCount !== 0 || oldStart !== 0)) throw new PatchError('malformed', `${where}: a new file with old lines`, { file: fileName, hunk: number });
    if (section.kind === 'delete' && newCount !== 0) throw new PatchError('malformed', `${where}: a deleted file with new lines`, { file: fileName, hunk: number });
    section.hunks.push(hunk);
  }
  if (section.hunks.length === 0) throw new PatchError('malformed', `${fileName}: a ---/+++ header without any hunk`, { file: fileName });
  // Lines that look like hunk lines right after the last hunk mean its header counts too few: applying the counted part would be half the change.
  let j = i;
  while (j < lines.length && stripCr(lines[j]) === '') j += 1;
  if (j < lines.length) {
    const next = stripCr(lines[j]);
    const header = next.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ');
    if (!header && next !== '-- ' && next !== '--' && /^[ +-]/.test(next)) {
      throw new PatchError('malformed', `${fileName}, hunk ${section.hunks.length}: "${next.slice(0, 80)}" follows the hunk but its header does not count it; the line counts of the @@ header are wrong`, { file: fileName, hunk: section.hunks.length });
    }
  }
  return i;
}

/** `\ No newline at end of file` applies to the line before it: an old-side line, a new-side line, or (context) both. */
function markNoEol(hunk, where, file, number) {
  const last = hunk.lines[hunk.lines.length - 1];
  if (!last || last.noEol) throw new PatchError('malformed', `${where}: a "\\ No newline at end of file" that follows no line`, { file, hunk: number });
  last.noEol = true;
  if (last.op !== '+') hunk.oldNoEol = true;
  if (last.op !== '-') hunk.newNoEol = true;
}

// ------------------------------------------------------------------ parsing: the envelope

function parseEnvelope(text) {
  const lines = text.split('\n').map(stripCr);
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines[lines.length - 1]?.trimEnd() !== '*** End Patch') throw new PatchError('malformed', 'the envelope does not end with "*** End Patch"');
  const files = [];
  const body = lines.slice(1, -1);
  const marker = (line, name) => (line.startsWith(`*** ${name}: `) ? line.slice(name.length + 6) : null);
  const pathOf = (value, name) => {
    const p = value.trim();
    if (p === '') throw new PatchError('malformed', `"*** ${name}:" without a file name`);
    return p;
  };
  const isFileMarker = (line) => /^\*\*\* (Add|Delete|Update) File: /.test(line);
  let i = 0;
  while (i < body.length) {
    const line = body[i];
    let value;
    if ((value = marker(line, 'Add File')) !== null) {
      const file = pathOf(value, 'Add File');
      const hunk = { header: '', oldStart: 0, oldCount: 0, newStart: 1, newCount: 0, anchors: [], endOfFile: false, oldNoEol: false, newNoEol: false, lines: [] };
      i += 1;
      while (i < body.length && !isFileMarker(body[i])) {
        if (!body[i].startsWith('+')) throw new PatchError('malformed', `${file}: a line of an added file must start with + ("${body[i].slice(0, 80)}")`, { file });
        hunk.lines.push({ op: '+', text: body[i].slice(1), cr: false });
        i += 1;
      }
      hunk.newCount = hunk.lines.length;
      files.push({ kind: 'add', oldPath: null, newPath: file, oldMode: null, newMode: null, format: 'envelope', hunks: hunk.lines.length ? [hunk] : [] });
    } else if ((value = marker(line, 'Delete File')) !== null || line.trimEnd() === '*** Delete File:') {
      const file = pathOf(value ?? '', 'Delete File');
      files.push({ kind: 'delete', oldPath: file, newPath: null, oldMode: null, newMode: null, format: 'envelope', hunks: [] });
      i += 1;
    } else if ((value = marker(line, 'Update File')) !== null) {
      const file = pathOf(value, 'Update File');
      i += 1;
      let moveTo = null;
      if (i < body.length && (value = marker(body[i], 'Move to')) !== null) { moveTo = pathOf(value, 'Move to'); i += 1; }
      const hunks = [];
      let current = null;
      let anchorsOpen = false; // the last line was an @@: the next @@ adds an anchor to the same section
      const where = () => `${file}, hunk ${hunks.length + (current ? 0 : 1)}`;
      const close = () => {
        if (!current) return;
        if (current.lines.length === 0) throw new PatchError('malformed', `${file}, hunk ${hunks.length + 1}: an @@ section without any line`, { file, hunk: hunks.length + 1 });
        current.oldCount = current.lines.filter((l) => l.op !== '+').length;
        current.newCount = current.lines.filter((l) => l.op !== '-').length;
        hunks.push(current);
        current = null;
      };
      const open = () => ({ header: '', oldStart: 0, oldCount: 0, newStart: 0, newCount: 0, anchors: [], endOfFile: false, oldNoEol: false, newNoEol: false, lines: [] });
      while (i < body.length && !isFileMarker(body[i])) {
        const l = body[i];
        if (l === '@@' || l.startsWith('@@ ')) {
          if (!anchorsOpen) { close(); current = open(); current.header = l; }
          else current.header += `\n${l}`;
          if (l !== '@@') current.anchors.push(l.slice(3));
          anchorsOpen = true;
        } else if (l.trimEnd() === '*** End of File') {
          if (!current || current.lines.length === 0) throw new PatchError('malformed', `${where()}: "*** End of File" before any change line`, { file });
          current.endOfFile = true;
          close();
          anchorsOpen = false;
          if (i + 1 < body.length && !isFileMarker(body[i + 1])) throw new PatchError('malformed', `${file}: lines after "*** End of File"`, { file });
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (!current) current = open();
          current.lines.push({ op: l === '' ? ' ' : l[0], text: l.slice(1), cr: false });
          anchorsOpen = false;
        } else {
          throw new PatchError('malformed', `${where()}: "${l.slice(0, 80)}" is not a change line (it must start with a space, - or +, or be @@ or *** End of File)`, { file });
        }
        i += 1;
      }
      close();
      if (hunks.length === 0 && moveTo === null) throw new PatchError('malformed', `${file}: "*** Update File" with nothing to change`, { file });
      files.push({ kind: moveTo === null ? 'modify' : 'rename', oldPath: file, newPath: moveTo ?? file, oldMode: null, newMode: null, format: 'envelope', hunks });
    } else {
      throw new PatchError('malformed', `"${line.slice(0, 80)}" is not an envelope line (expected *** Add File:, *** Delete File: or *** Update File:)`);
    }
  }
  if (files.length === 0) throw new PatchError('empty', 'the envelope holds no file change');
  return { format: 'envelope', files };
}

// ------------------------------------------------------------------ matching

const PUNCTUATION = /[\u2010-\u2015\u2212\u2018-\u201f\u00a0\u2000-\u200a\u202f\u205f\u3000]/g;
const PUNCTUATION_MAP = (ch) => {
  const code = ch.charCodeAt(0);
  if ((code >= 0x2010 && code <= 0x2015) || code === 0x2212) return '-';
  if (code >= 0x2018 && code <= 0x201b) return '\'';
  if (code >= 0x201c && code <= 0x201f) return '"';
  return ' ';
};
const LEVEL_KEY = [
  (s) => s,
  (s) => s.trimEnd(),
  (s) => s.trim(),
  (s) => s.replace(PUNCTUATION, PUNCTUATION_MAP).trim(),
];

/** File text -> lines { text, cr, nl }. An empty text has no line; text without a final LF has a last line with nl false. */
function splitFile(text) {
  if (text === '') return [];
  const parts = text.split('\n');
  const last = parts.pop();
  const lines = parts.map((part) => (part.endsWith('\r') ? { text: part.slice(0, -1), cr: true, nl: true } : { text: part, cr: false, nl: true }));
  if (last !== '') lines.push(last.endsWith('\r') ? { text: last.slice(0, -1), cr: true, nl: false } : { text: last, cr: false, nl: false });
  return lines;
}

const joinFile = (lines) => lines.map((l) => l.text + (l.cr ? '\r' : '') + (l.nl ? '\n' : '')).join('');

/** CRLF when more line ends of the file are CRLF than LF. */
function prefersCrlf(lines) {
  let crlf = 0; let lf = 0;
  for (const l of lines) if (l.nl) { if (l.cr) crlf += 1; else lf += 1; }
  return crlf > lf;
}

/**
 * Positions in [from, to] where `needle` (strings) matches `keys` (strings at one level); stops after `limit` hits. Every line compared is taken
 * from `budget.left`; a search that would cost more (a long hunk against a long file of nearly equal lines) is refused, not run for minutes.
 */
function findAll(keys, needle, from, to, limit, budget) {
  const hits = [];
  for (let pos = from; pos <= to && hits.length < limit; pos += 1) {
    let k = 0;
    while (k < needle.length && keys[pos + k] === needle[k]) k += 1;
    budget.left -= k + 1;
    if (budget.left < 0) throw new PatchError('too_large', `${budget.describe}: finding the place of the hunk would compare more than ${budget.max} lines`, { file: budget.file, hunk: budget.hunk });
    if (k === needle.length) hits.push(pos);
  }
  return hits;
}

/**
 * Places old lines in the file. Returns { pos, fuzz }. `allowed` restricts the start positions: { from, to } or a single `only`.
 * At each rung: the expected position wins if it matches (the line numbers say so); otherwise one hit is taken and two are ambiguous.
 */
function locate(cache, oldTexts, { from, to, only = null, expected = null, maxFuzz, describe, file, hunk }) {
  const budget = Object.assign(cache.budget, { describe, file, hunk });
  for (let level = 0; level <= maxFuzz; level += 1) {
    const keys = cache(level);
    const needle = oldTexts.map(LEVEL_KEY[level]);
    if (only !== null) {
      if (only >= from && only <= to && findAll(keys, needle, only, only, 1, budget).length) return { pos: only, fuzz: level };
      continue;
    }
    if (expected !== null && expected >= from && expected <= to && findAll(keys, needle, expected, expected, 1, budget).length) return { pos: expected, fuzz: level };
    const hits = findAll(keys, needle, from, to, 2, budget);
    if (hits.length === 1) return { pos: hits[0], fuzz: level };
    if (hits.length > 1) {
      throw new PatchError('ambiguous', `${describe}: the lines match at line ${hits[0] + 1} and at line ${hits[1] + 1} (${FUZZ_LEVELS[level]}); the patch does not say which, so nothing is applied. Add context lines that tell them apart.`, { file, hunk });
    }
  }
  return null;
}

/**
 * Applies one parsed file patch to the text of the file (null when it does not exist). Returns { text, mode, hunks: report[] } or throws.
 * text is null for a deleted file. report: { hunk, header, line, expectedLine, offset, fuzz, fuzzName, matchedLines, anchorLines }.
 * options: { maxFuzz = 3 }
 */
export function applyFilePatch(original, filePatch, options = {}) {
  const maxFuzz = Number.isInteger(options.maxFuzz) ? Math.max(0, Math.min(3, options.maxFuzz)) : 3;
  const file = filePatch.newPath ?? filePatch.oldPath;
  const reports = [];
  if (filePatch.kind === 'add') {
    if (original !== null && original !== undefined) throw new PatchError('file_exists', `${file}: the patch creates it, but it already exists`, { file });
    original = '';
  } else if (original === null || original === undefined) {
    throw new PatchError('file_missing', `${filePatch.oldPath}: the patch changes it, but it does not exist`, { file: filePatch.oldPath });
  }
  if (typeof original !== 'string') throw new PatchError('malformed', `${file}: the file text is not a string`, { file });
  if (filePatch.kind === 'delete' && filePatch.format === 'envelope') return { text: null, mode: null, hunks: reports };

  // A byte order mark stays where it is: it is set aside while matching unless the patch itself writes one (a diff git made of such a file).
  const patchHasBom = filePatch.hunks.some((h) => h.lines.some((l) => l.text.includes('\ufeff')));
  const bom = !patchHasBom && original.startsWith('\ufeff') ? '\ufeff' : '';
  const lines = splitFile(bom ? original.slice(1) : original);
  const n = lines.length;
  const limits = limitsOf(options);
  const keyCache = [];
  const cache = (level) => (keyCache[level] ??= lines.map((l) => LEVEL_KEY[level](l.text)));
  cache.budget = { left: limits.maxSearchSteps, max: limits.maxSearchSteps };
  const patchLines = filePatch.hunks.flatMap((h) => h.lines);
  const placed = [];
  let cursor = 0; // hunks are placed in order and never overlap
  let delta = 0; // how far the hunks before this one moved from the lines the diff names
  filePatch.hunks.forEach((hunk, index) => {
    const number = index + 1;
    const describe = `${file}, hunk ${number}${hunk.header && !hunk.header.includes('\n') ? ` (${hunk.header.slice(0, 60)})` : ''}`;
    const oldLines = hunk.lines.filter((l) => l.op !== '+');
    const oldTexts = oldLines.map((l) => l.text);
    const m = oldTexts.length;
    let pos = null; let fuzz = 0; let expectedLine = null; const anchorLines = [];
    if (filePatch.format === 'unified') {
      const nominal = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
      const expected = nominal + delta;
      expectedLine = nominal + 1;
      if (m === 0) {
        // Nothing to match: only the start of the file (the diff names line 0) or its end is a place that needs no line.
        if (hunk.oldStart === 0 && cursor === 0) pos = 0;
        else if (expected === n && n >= cursor) pos = n;
        else throw new PatchError('no_context', `${describe}: the hunk has no line to match and is not at the start or the end of the file; it would be placed by its line number alone`, { file, hunk: number });
      } else {
        const lastChange = findLastIndex(hunk.lines, (l) => l.op !== ' ');
        const trailingContext = lastChange < 0 ? hunk.lines.length : hunk.lines.length - 1 - lastChange;
        // As git: a hunk that names line 1 must match at the start; a hunk without trailing context must match at the end.
        const atStart = hunk.oldStart <= 1;
        const atEnd = trailingContext === 0;
        let only = null;
        if (atStart && atEnd) only = n - m === 0 ? 0 : -1;
        else if (atStart) only = 0;
        else if (atEnd) only = n - m;
        const found = locate(cache, oldTexts, { from: cursor, to: n - m, only, expected, maxFuzz, describe, file, hunk: number });
        if (!found) throw mismatch(describe, file, number, only !== null && atStart ? 'at the start of the file' : only !== null ? 'at the end of the file' : null, maxFuzz);
        ({ pos, fuzz } = found);
      }
    } else {
      // The envelope has no line numbers: anchors, then the lines, searched after the hunk before.
      let from = cursor;
      hunk.anchors.forEach((anchor, a) => {
        const found = a === 0
          ? locate(cache, [anchor], { from, to: n - 1, maxFuzz, describe: `${describe}, anchor "${anchor.slice(0, 60)}"`, file, hunk: number })
          : nearest(cache, [anchor], from, n - 1, maxFuzz, { describe, file, hunk: number });
        if (!found) throw new PatchError('context_mismatch', `${describe}: the anchor line "${anchor.slice(0, 80)}" was not found after line ${from}`, { file, hunk: number });
        anchorLines.push(found.pos + 1);
        fuzz = Math.max(fuzz, found.fuzz);
        from = found.pos + 1;
      });
      if (m === 0) {
        pos = hunk.anchors.length && !hunk.endOfFile ? from : n;
      } else {
        const found = hunk.endOfFile
          ? locate(cache, oldTexts, { from, to: n - m, only: n - m, maxFuzz, describe, file, hunk: number })
          : hunk.anchors.length
            ? nearest(cache, oldTexts, from, n - m, maxFuzz, { describe, file, hunk: number })
            : locate(cache, oldTexts, { from, to: n - m, maxFuzz, describe, file, hunk: number });
        if (!found) throw mismatch(describe, file, number, hunk.endOfFile ? 'at the end of the file' : null, maxFuzz);
        pos = found.pos;
        fuzz = Math.max(fuzz, found.fuzz);
      }
    }
    if (filePatch.format === 'unified') {
      const reachesEnd = pos + m === n;
      if (hunk.newNoEol && !reachesEnd) throw new PatchError('not_at_eof', `${describe}: the patch says its last line ends the file without a newline, but the hunk is not at the end of the file`, { file, hunk: number });
      if (hunk.oldNoEol && !(reachesEnd && n > 0 && !lines[n - 1].nl)) {
        throw new PatchError('context_mismatch', `${describe}: the patch says the old last line has no newline, but ${reachesEnd ? 'the file ends with one' : 'the hunk is not at the end of the file'}`, { file, hunk: number });
      }
      const offset = pos + 1 - expectedLine;
      delta = offset;
      reports.push({ hunk: number, header: hunk.header, line: pos + 1, expectedLine, offset, fuzz, fuzzName: FUZZ_LEVELS[fuzz], matchedLines: m, anchorLines });
    } else {
      reports.push({ hunk: number, header: hunk.header, line: pos + 1, expectedLine: null, offset: null, fuzz, fuzzName: FUZZ_LEVELS[fuzz], matchedLines: m, anchorLines });
    }
    placed.push({ hunk, pos, m });
    cursor = pos + m;
  });

  if (filePatch.kind === 'delete') {
    const left = n - placed.reduce((sum, p) => sum + p.m, 0);
    if (left !== 0) throw new PatchError('delete_not_empty', `${file}: the patch deletes the file, but ${left} of its lines are not removed by it`, { file });
    return { text: null, mode: null, hunks: reports };
  }

  // Line ends of the + lines. A diff git wrote from a CRLF file carries the CR of each line, and it is written as given (literal). A patch with a CR
  // on every line while the lines it matched have none was converted on its way here (a CRLF clipboard): its CRs are dropped. Otherwise (no CR at
  // all, or dropped) a + line takes the line end most of the file uses.
  const matched = placed.flatMap((p) => lines.slice(p.pos, p.pos + p.m));
  const anyCr = patchLines.some((l) => l.cr);
  const inTransit = filePatch.kind !== 'add' && anyCr && patchLines.every((l) => l.cr) && matched.every((l) => !l.cr);
  const literal = anyCr && !inTransit;
  const crlf = !literal && prefersCrlf(lines);
  const out = [];
  let at = 0;
  for (const { hunk, pos, m } of placed) {
    for (; at < pos; at += 1) out.push({ ...lines[at] });
    let k = pos;
    const reachesEnd = pos + m === n;
    const startOfHunk = out.length;
    for (const l of hunk.lines) {
      if (l.op === ' ') { out.push({ ...lines[k] }); k += 1; }
      else if (l.op === '-') k += 1;
      else out.push({ text: l.text, cr: literal ? l.cr : crlf, nl: true });
    }
    at = k;
    if (reachesEnd && out.length > startOfHunk && hunk.newNoEol) {
      // Only the patch can take the final newline away; a + line always has one, a context line keeps the file's.
      const lastNew = hunk.lines[findLastIndex(hunk.lines, (l) => l.op !== '-')];
      const last = out[out.length - 1];
      last.nl = false;
      if (lastNew.op === '+') last.cr = literal && lastNew.cr; // without a newline, a CR is part of the line itself
    }
  }
  for (; at < n; at += 1) out.push({ ...lines[at] });
  // A line without newline that is no longer the last one gets one, in the file's style.
  for (let k = 0; k < out.length - 1; k += 1) if (!out[k].nl) { out[k].nl = true; if (!out[k].cr) out[k].cr = crlf; }
  return { text: bom + joinFile(out), mode: filePatch.newMode, hunks: reports };
}

function findLastIndex(list, test) {
  for (let i = list.length - 1; i >= 0; i -= 1) if (test(list[i])) return i;
  return -1;
}

/** The first match at or after `from` at the lowest rung (an anchor stands where line numbers would). */
function nearest(cache, texts, from, to, maxFuzz, where) {
  const budget = Object.assign(cache.budget, where);
  for (let level = 0; level <= maxFuzz; level += 1) {
    const hits = findAll(cache(level), texts.map(LEVEL_KEY[level]), from, to, 1, budget);
    if (hits.length) return { pos: hits[0], fuzz: level };
  }
  return null;
}

function mismatch(describe, file, hunk, where, maxFuzz) {
  return new PatchError('context_mismatch', `${describe}: the old lines of the hunk were not found ${where ?? 'after the hunk before it'} (tried: ${FUZZ_LEVELS.slice(0, maxFuzz + 1).join(', ')}); the file is not what the patch expects`, { file, hunk });
}

// ------------------------------------------------------------------ the whole patch

/**
 * Parses and applies a patch to the given files, all or nothing. files: an object or a Map from path to text (null or missing: the file does not
 * exist). Returns { ok: true, format, changes, reports } or { ok: false, error: { code, message, file, hunk } }. Never throws for any input.
 * changes: { path, action: 'create' | 'modify' | 'delete', text, mode }[] (text null for a delete; mode null when the patch names none).
 * reports: one per file section, { kind, oldPath, newPath, hunks: report[] }. options: { limits, maxFuzz }.
 */
export function applyPatch(text, files, options = {}) {
  try {
    const limits = limitsOf(options);
    const parsed = parsePatch(text, options);
    const get = (p) => {
      const value = files instanceof Map ? files.get(p) : (files && Object.prototype.hasOwnProperty.call(files, p) ? files[p] : undefined);
      return value === undefined ? null : value;
    };
    const initial = new Map();
    const state = new Map();
    const modes = new Map();
    const order = [];
    const read = (p) => {
      if (!initial.has(p)) {
        const value = get(p);
        if (value !== null && typeof value !== 'string') throw new PatchError('malformed', `${p}: the file text is not a string`, { file: p });
        if (value !== null && (value.length > limits.maxFileBytes || utf8Length(value) > limits.maxFileBytes)) {
          throw new PatchError('too_large', `${p}: the file is larger than ${limits.maxFileBytes} bytes`, { file: p });
        }
        initial.set(p, value);
        state.set(p, value);
        order.push(p);
      }
      return state.get(p);
    };
    const reports = [];
    for (const filePatch of parsed.files) {
      const source = filePatch.oldPath !== null ? read(filePatch.oldPath) : null;
      const target = filePatch.newPath !== null ? read(filePatch.newPath) : null;
      if ((filePatch.kind === 'rename' || filePatch.kind === 'copy') && target !== null) {
        throw new PatchError('file_exists', `${filePatch.newPath}: the patch ${filePatch.kind === 'rename' ? 'moves' : 'copies'} ${filePatch.oldPath} there, but it already exists`, { file: filePatch.newPath });
      }
      const result = applyFilePatch(filePatch.kind === 'add' ? target : source, filePatch, options);
      if (filePatch.kind === 'delete') state.set(filePatch.oldPath, null);
      else {
        if (filePatch.kind === 'rename') state.set(filePatch.oldPath, null);
        state.set(filePatch.newPath, result.text);
        if (result.mode) modes.set(filePatch.newPath, result.mode);
      }
      reports.push({ kind: filePatch.kind, oldPath: filePatch.oldPath, newPath: filePatch.newPath, hunks: result.hunks });
    }
    const changes = [];
    for (const p of order) {
      const before = initial.get(p);
      const after = state.get(p);
      const mode = modes.get(p) ?? null;
      if (before === null && after === null) continue;
      if (after === null) changes.push({ path: p, action: 'delete', text: null, mode: null });
      else if (before === null) changes.push({ path: p, action: 'create', text: after, mode });
      else if (before !== after || mode !== null) changes.push({ path: p, action: 'modify', text: after, mode });
    }
    return { ok: true, format: parsed.format, changes, reports };
  } catch (error) {
    if (error instanceof PatchError) return { ok: false, error: { code: error.code, message: error.message, file: error.file, hunk: error.hunk } };
    // Every refusal is a PatchError; anything else is a bug of the engine, reported as a refusal so that no half result is ever used.
    return { ok: false, error: { code: 'internal_error', message: `the patch could not be applied: ${error && error.message ? error.message : String(error)}`, file: null, hunk: null } };
  }
}
