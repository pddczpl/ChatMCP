// What the approval card shows for a call that changes files (P8 ux-7), and what the call is held to once the owner has answered.
//
// The plans (planEdit, planWrite, planWriteBatch in lib/local-tools.mjs) say exactly what the call would leave on disk. This module cuts that down to what a person can look at
// (at most 20 files, 200 rows of each file, and a bounded number of characters for the whole card; what is left out is counted, never silently dropped) and records, for each file, the hash
// of the bytes the plan was made from, so that the call which follows the answer can refuse to run on a file that has changed since (`stale_after_approval`).
//
// Nothing here reads a file. Secrets are masked by PermissionGate, which owns the list of secrets and masks the card the way it masks every other word of the card.
import { createHash } from 'node:crypto';

export const PREVIEW_LIMITS = Object.freeze({
  /** Files shown on one card; the others are counted. */
  files: 20,
  /** Rows (changed lines and their context) shown for one file; the others are counted. */
  rows: 200,
  /** Characters of one line; a longer line is cut and says how much was left out. */
  rowChars: 400,
  /** Characters of rows for the whole card; the rows past it are counted. */
  chars: 120_000,
  /** Characters of the message when the call would be refused. */
  messageChars: 500,
});

export const FILE_CHANGE_TOOLS = Object.freeze(['write_file', 'edit_file', 'files_apply_patch', 'files_write_batch']);

/** A value written the same way whatever the order of its keys. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** The arguments of a call as one hash: the card was drawn for these arguments and for no others. */
export const argumentsDigest = (args) => createHash('sha256').update(canonicalJson(args ?? {})).digest('hex');

const terminatorOf = (text) => (text.endsWith('\r\n') ? '\r\n' : text.endsWith('\n') ? '\n' : '');

/** A row of at most rowChars characters of text, with its own line ending kept; `omitted` is how many characters were left out. */
function clipRow(row) {
  const ending = terminatorOf(row.text);
  const body = ending ? row.text.slice(0, -ending.length) : row.text;
  if (body.length <= PREVIEW_LIMITS.rowChars) return { kind: row.kind, text: row.text };
  let end = PREVIEW_LIMITS.rowChars;
  const last = body.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // never cut a character in two
  return { kind: row.kind, text: body.slice(0, end) + ending, omitted: body.length - end };
}

/**
 * The frames of a private key, as the source of a regular expression. PGP arms its private keys as `-----BEGIN PGP PRIVATE KEY BLOCK-----`, which is why "PRIVATE KEY" may be followed by
 * " BLOCK". A public key (`PUBLIC KEY`, `PGP PUBLIC KEY BLOCK`) is not one: it is not a secret.
 */
export const PRIVATE_KEY_BEGIN = String.raw`-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----`;
export const PRIVATE_KEY_END = String.raw`-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----`;
const BEGIN_FRAMES = new RegExp(PRIVATE_KEY_BEGIN, 'g');
const END_FRAMES = new RegExp(PRIVATE_KEY_END, 'g');

/** The frames of a text in the order they come: `{ begin, start, end }`. Two scans of the text, each of them linear. */
function framesOf(text) {
  const found = [];
  for (const match of text.matchAll(BEGIN_FRAMES)) found.push({ begin: true, start: match.index, end: match.index + match[0].length });
  for (const match of text.matchAll(END_FRAMES)) found.push({ begin: false, start: match.index, end: match.index + match[0].length });
  return found.sort((a, b) => a.start - b.start);
}

/**
 * The parts of a text that are key material, given whether the body of a key is open where the text starts. A BEGIN frame opens a body (one that is open already takes it for a part of itself) and
 * the first END frame after it closes it; an END frame with nothing open is stray.
 *   - `closed`: between a BEGIN frame and the END frame that closes it, both in the text
 *   - `head`: from the start of the text to the first END frame, when a body was open at the start (the end of a key that began on an earlier line)
 *   - `tail`: from the BEGIN frame that opened a body to the end of the text, when no END frame closes it (the start of a key that goes on in the next line)
 */
function keyParts(text, open) {
  const parts = [];
  let from = 0;
  let began = false;
  for (const frame of framesOf(text)) {
    if (!open && frame.begin) {
      open = true;
      began = true;
      from = frame.end;
    } else if (open && !frame.begin) {
      // an END frame that shares its dashes with the BEGIN frame before it closes a key with nothing in it
      parts.push({ kind: began ? 'closed' : 'head', start: from, end: Math.max(frame.start, from) });
      open = false;
    }
  }
  if (open) parts.push({ kind: 'tail', start: from, end: text.length });
  return parts;
}

// ---- What looks like a key. The frames tell where to look; they do not tell what is a key. A model can write a BEGIN frame in front of anything, and a card that hid whatever follows one would let
// the model hide its code from the owner. So what is hidden in a body is base64, and only that:
//   - a RUN of 16 characters or more of base64 (A-Z a-z 0-9 + /, and _ - for base64url, with up to two = after it) is replaced by [REDACTED] wherever it stands in a row, and every other character of
//     the row stays where it is: the decoration (a comment sign, quotes, echo "..." >> key, b"...\n", a backtick-n between the lines of a one-line key, %0A, a table bar ...) is not what is hidden. A
//     list of decorations is never complete, so it must not be what decides secrecy (the fourth audit of PR #103 found the whole body of a real key on the card in 23 of 31 shapes when it was);
//   - a row of a body that is ONE short token (the last line of a key: 4 characters or more, with a capital, a digit or a sign) or the checksum line of PGP is hidden whole, and so is a part of a row
//     (the rest of the line of a frame, a one-line key) that is nothing else but tokens of base64: looksLikeKey.
// Code, commands, words and the armour headers of PGP have no run of 16 characters and are not hidden: they are not key material. A long word in the middle of a command is hidden by itself,
// and the card counts the row.
const KEY_TOKEN = /^[A-Za-z0-9+/_-]+={0,2}$/;
const KEY_CHECKSUM = /^=[A-Za-z0-9+/]{4}$/;
const KEY_ESCAPES = /\\(?:[nrt/]|u[0-9a-fA-F]{4})/g;
const LEFT_OF_A_KEY = new Set([' ', '\t', '\r', '\n', '"', "'", '`', '#', '>', ';', '%', '*', '/']);
const RIGHT_OF_A_KEY = new Set([' ', '\t', '\r', '\n', '"', "'", '`', ',', ';', '\\', '+']);

/** The text of a row, or of a part of a row, without what a key is wrapped in in code. Loops and no regular expression with a * before $: a megabyte of one character is read once. */
function keyCore(text) {
  let start = 0;
  let end = text.length;
  while (RIGHT_OF_A_KEY.has(text[end - 1])) end -= 1; // text[-1] is undefined and in no set: the loops stop at the ends of the text
  while (LEFT_OF_A_KEY.has(text[start])) start += 1;
  if (text[start] === '-' && (text[start + 1] === ' ' || text[start + 1] === '\t')) start += 1; // the dash of a list item (YAML); the spaces after it are cut with all the others
  return text.slice(start, end);
}

function keyToken(token, last, only) {
  if (!KEY_TOKEN.test(token)) return last && KEY_CHECKSUM.test(token);
  if (token.length >= 16) return true;
  // the short last line of a body has to look random: a capital, a digit or one of + / = (a whole line of a body), a digit or one of + / = (the end of several tokens)
  return last && token.length >= 4 && (only ? /[A-Z0-9+/=]/ : /[0-9+/=]/).test(token);
}

/**
 * Whether a row (`whole`: one line of a body, which is one token) or a part of a row (the text after a BEGIN frame, before an END frame or between them: as many tokens as a key written on one line
 * has) looks like key material. A command with arguments, a statement, a call, a URL, a word, a header and a blank line do not.
 */
export function looksLikeKey(text, whole = false) {
  const tokens = keyCore(text).replace(KEY_ESCAPES, ' ').split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || (whole && tokens.length > 1)) return false;
  return tokens.every((token, index) => keyToken(token, index === tokens.length - 1, tokens.length === 1));
}

const KEY_RUN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
/** The text with every run of 16 characters or more of base64 replaced by [REDACTED]; every other character stays where it is. One reading of the text: no run is searched for twice. */
const hideKeyRuns = (text) => text.replace(KEY_RUN, '[REDACTED]');
const endingOf = (text) => (text.endsWith('\r\n') ? '\r\n' : text.endsWith('\n') ? '\n' : text.endsWith('\r') ? '\r' : '');

/** A whole row of a body (a card row keeps its line ending): hidden whole when it is one token of base64, else every run of base64 in it is hidden where it stands. */
function hideBodyRow(text) {
  return looksLikeKey(text, true) ? `[REDACTED]${endingOf(text)}` : hideKeyRuns(text);
}

/** A part of a row (the rest of the line of a frame, a key in one line): hidden whole when it is nothing but base64, else every run of base64 in it is hidden where it stands. */
function hideKeyPart(part) {
  return looksLikeKey(part) ? '[REDACTED]' : hideKeyRuns(part);
}

/**
 * The text between two frames (or after a BEGIN frame, or before an END frame) with the key material in it hidden. Over several lines the lines that are one token of base64 become one [REDACTED]
 * line (a run of them, one), a line with something else in it has its runs of base64 hidden where they stand, and the others stay, so that the frames stay on lines of their own and a line of code
 * among the lines of a key stays where it is.
 */
function hideKeyText(inner) {
  const lines = inner.split('\n');
  const out = [];
  let run = false;
  lines.forEach((line, index) => {
    const edge = index === 0 || index === lines.length - 1; // the rest of the line of a frame
    const shown = edge ? hideKeyPart(line) : hideBodyRow(line);
    const marker = !edge && (shown === '[REDACTED]' || shown === '[REDACTED]\r'); // a run of hidden lines is made of the lines between the two lines of the frames: an edge cannot be a part of one
    if (marker && run) return;
    out.push(shown);
    run = marker;
  });
  return out.join('\n');
}

/**
 * The text with its key material replaced by [REDACTED]; the frames and the words around them stay, and so does everything that is not base64. A key that begins and ends in the text is
 * replaced, and a block over several lines keeps its frames on lines of their own. With `edges`, the head and the tail are replaced too (what is base64 in them): that is what the card does
 * with a row, where the key goes on in the lines before or after. Without it they are left alone, as they are for a text that is not read line by line.
 * It reads the text once, whatever it holds: a line of a megabyte of BEGIN frames is not a search from every frame to the end of the line.
 */
function hideKeyParts(text, open, edges) {
  if (!open && !text.includes('PRIVATE KEY')) return text;
  let out = '';
  let from = 0;
  for (const part of keyParts(text, open)) {
    let { end } = part;
    if (part.kind === 'closed') {
      out += text.slice(from, part.start) + hideKeyText(text.slice(part.start, end));
      from = end;
      continue;
    }
    if (!edges) continue;
    if (part.kind === 'tail') while (end > part.start && (text[end - 1] === '\n' || text[end - 1] === '\r')) end -= 1;
    const piece = text.slice(part.start, end);
    const shown = hideKeyPart(piece);
    if (shown === piece) continue;
    out += text.slice(from, part.start) + shown;
    from = end;
  }
  return out + text.slice(from);
}

/** A text with every key that begins and ends in it hidden (the masker uses this); a body that goes on beyond the text is not touched. */
export const hideKeyBlocks = (text) => hideKeyParts(text, false, false);

/**
 * A line (or a row of the card: its line ending stays) that holds a frame, with the key material in it hidden: a key that begins and ends in it, the text that comes after a BEGIN frame when the
 * body goes on in the next line, and the text that comes before the END frame of a body that was open when the line began (`open`); in each case the base64 in it (see hideKeyPart).
 */
export const hideKeyMaterial = (line, open) => hideKeyParts(line, open, true);

/**
 * What a text says about the private keys in it, line by line (0-based):
 *   - `body`: the lines that lie between the line of a BEGIN frame and the line of the END frame, or to the end of the text when the end is not there. This is where a key is, by place; what in a
 *     line is key material is for `hideBodyRow`. The card cuts a file into rows, which keeps their place.
 *   - `framed`: the lines that hold a frame, with whether a body was open where each of them began. They are not body lines: the frames stay, and `hideKeyMaterial` hides the key material in them.
 *   - `lines`: the lines.
 * What a line leaves open is told by the frame that comes LAST in it: a key that begins and ends in one line (a service-account file keeps the whole key in one line, its line breaks written \n)
 * leaves nothing open, and the lines after it are not its body.
 */
export function keyLines(text) {
  const body = new Set();
  const framed = new Map();
  const lines = text.split('\n');
  let open = false;
  lines.forEach((line, index) => {
    const frames = line.includes('PRIVATE KEY') ? framesOf(line) : [];
    if (frames.length === 0) {
      if (open) body.add(index);
      return;
    }
    framed.set(index, open);
    open = frames[frames.length - 1].begin;
  });
  return { body, framed, lines };
}

/** The 0-based numbers of the lines that lie between a BEGIN frame and its END frame (see keyLines). */
export const privateKeyBodyLines = (text) => keyLines(text).body;

/** Whether a text holds private key material: a line of a body with base64 in it, key material in a line that holds a frame, or a key that begins and ends in one line. */
export function holdsPrivateKey(text) {
  if (!text.includes('PRIVATE KEY')) return false;
  const { body, framed, lines } = keyLines(text);
  for (const index of body) if (hideBodyRow(lines[index]) !== lines[index]) return true;
  for (const [index, open] of framed) if (hideKeyMaterial(lines[index], open) !== lines[index]) return true;
  return false;
}

const NO_KEYS = Object.freeze({ body: new Set(), framed: new Map(), lines: [] });

/**
 * The row at `place` of the text that `keys` describes, with the key material in it hidden: a line of a body that is one token of base64 becomes a marker (it keeps its line ending), any other
 * line of a body has the runs of base64 in it replaced where they stand, a row that holds a frame has the key material in it cut out (the frames, the words around them and the line ending stay),
 * and any other row is as it was.
 */
export function hideKeyRow(keys, place, text) {
  if (keys.body.has(place)) return hideBodyRow(text);
  if (keys.framed.has(place)) return hideKeyMaterial(text, keys.framed.get(place));
  return text;
}

/** The rows of a hunk with the key material hidden (see hideKeyRow); a row that is hidden is a new object, any other is the row itself. */
function hideKeyBodies(hunk, oldKeys, newKeys) {
  if (!oldKeys.framed.size && !newKeys.framed.size) return hunk.rows; // a body starts at a line with a frame: no such line, no key
  let lead = 0;
  while (lead < hunk.rows.length && hunk.rows[lead].kind === 'context') lead += 1;
  // The context before the first change is lines of both texts; from there each row moves the place in the old text (not an added row) and in the new text (not a removed row).
  let old = hunk.baselineStart - lead;
  let current = hunk.currentStart - lead;
  return hunk.rows.map((row) => {
    const keys = row.kind === 'removed' ? oldKeys : newKeys;
    const place = row.kind === 'removed' ? old : current;
    if (row.kind !== 'added') old += 1;
    if (row.kind !== 'removed') current += 1;
    const text = hideKeyRow(keys, place, row.text);
    return text === row.text ? row : { kind: row.kind, text };
  });
}

/** One file of the card. `budget.chars` is what is left of the characters of the whole card, and is used up here. */
function fileEntry(plan, budget) {
  const hunks = [];
  let shown = 0;
  let total = 0;
  for (const hunk of plan.hunks) total += hunk.rows.length;
  const oldKeys = typeof plan.oldText === 'string' ? keyLines(plan.oldText) : NO_KEYS;
  const newKeys = typeof plan.newText === 'string' ? keyLines(plan.newText) : NO_KEYS;
  let hiddenKeyRows = 0;
  for (const hunk of plan.hunks) {
    if (shown >= PREVIEW_LIMITS.rows || budget.chars <= 0) break;
    const rows = [];
    for (const [index, row] of hideKeyBodies(hunk, oldKeys, newKeys).entries()) {
      if (shown + rows.length >= PREVIEW_LIMITS.rows || budget.chars <= 0) break;
      if (row !== hunk.rows[index]) hiddenKeyRows += 1; // the card says how many rows it hid as key material, so that a file that hides rows it should not is seen
      const clipped = clipRow(row);
      budget.chars -= clipped.text.length;
      rows.push(clipped);
    }
    shown += rows.length;
    hunks.push({
      baselineStart: hunk.baselineStart, baselineEnd: hunk.baselineEnd, currentStart: hunk.currentStart, currentEnd: hunk.currentEnd,
      removed: hunk.removed, added: hunk.added, invisibleOnly: hunk.invisibleOnly, rows,
      ...(rows.length < hunk.rows.length ? { cut: hunk.rows.length - rows.length } : {}),
    });
  }
  return {
    path: plan.relative,
    action: plan.kind === 'edit' ? 'edit' : plan.created ? 'create' : 'overwrite',
    baseSha: plan.baseSha,
    additions: plan.additions,
    deletions: plan.deletions,
    unchanged: plan.unchanged,
    ...(plan.oldUnreadable ? { oldUnreadable: true } : {}),
    ...(hiddenKeyRows > 0 ? { hiddenKeyRows } : {}),
    hunks,
    shownRows: shown,
    hiddenRows: total - shown,
    truncated: total > shown,
  };
}

/**
 * The card for a call whose plans are known: every file with its hunks, bounded. With `failure` ({code, message}) the call would be refused when it runs: the card says so, and shows no file.
 * @returns {{files: object[], fileCount: number, hiddenFiles: number, truncated: boolean, error?: {code: string, message: string}}}
 */
export function buildChangePreview(plans, failure = null) {
  if (failure) {
    const message = String(failure.message ?? '');
    return { files: [], fileCount: 0, hiddenFiles: 0, truncated: false, error: { code: String(failure.code ?? 'local_error'), message: message.length > PREVIEW_LIMITS.messageChars ? `${message.slice(0, PREVIEW_LIMITS.messageChars)}…` : message } };
  }
  const budget = { chars: PREVIEW_LIMITS.chars };
  const files = plans.slice(0, PREVIEW_LIMITS.files).map((plan) => fileEntry(plan, budget));
  // A call that touches private key material says so: the gate then leaves the words the model wrote out of the card, because they can hold a line of the body, which only its place gives away.
  const keys = plans.some((plan) => [plan.oldText, plan.newText].some((text) => typeof text === 'string' && holdsPrivateKey(text)));
  return { files, fileCount: plans.length, hiddenFiles: plans.length - files.length, truncated: plans.length > files.length || files.some((file) => file.truncated), ...(keys ? { privateKeys: true } : {}) };
}

/**
 * What the call that follows the owner's answer is held to: the tool, the arguments the card was drawn for, and for EVERY file of the call (also the ones past the twenty of the card) the hash
 * of the bytes the plan was made from (null for a file that was not there).
 */
export function buildApprovalGuard(tool, args, plans) {
  return { tool, argsSha256: argumentsDigest(args), files: plans.map((plan) => ({ path: plan.relative, baseSha: plan.baseSha })) };
}

/** Whether a guard was made for this very call. */
export const guardMatches = (guard, tool, args) => Boolean(guard) && guard.tool === tool && guard.argsSha256 === argumentsDigest(args) && Array.isArray(guard.files);
