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
 * The 0-based numbers of the lines that are the body of a private key: between a `-----BEGIN ... PRIVATE KEY-----` line and the `-----END` line (or the end of the text, when the end is not
 * there). The frame lines are not secret and stay. A line of a body looks like any base64, so only its place tells what it is; the card cuts a file into rows, which keeps their place.
 */
export function privateKeyBodyLines(text) {
  const inside = new Set();
  let open = false;
  text.split('\n').forEach((line, index) => {
    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) open = true;
    else if (/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) open = false;
    else if (open) inside.add(index);
  });
  return inside;
}

/** The rows of a hunk, with the rows that are a line of a private key's body replaced by a marker (the row keeps its kind and its line ending). */
function hideKeyBodies(hunk, oldLines, newLines) {
  if (!oldLines.size && !newLines.size) return hunk.rows;
  let lead = 0;
  while (lead < hunk.rows.length && hunk.rows[lead].kind === 'context') lead += 1;
  // The context before the first change is lines of both texts; from there each row moves the place in the old text (not an added row) and in the new text (not a removed row).
  let old = hunk.baselineStart - lead;
  let current = hunk.currentStart - lead;
  return hunk.rows.map((row) => {
    const secret = row.kind === 'removed' ? oldLines.has(old) : newLines.has(current);
    if (row.kind !== 'added') old += 1;
    if (row.kind !== 'removed') current += 1;
    return secret ? { kind: row.kind, text: `[REDACTED]${terminatorOf(row.text)}` } : row;
  });
}

/** One file of the card. `budget.chars` is what is left of the characters of the whole card, and is used up here. */
function fileEntry(plan, budget) {
  const hunks = [];
  let shown = 0;
  let total = 0;
  for (const hunk of plan.hunks) total += hunk.rows.length;
  const oldLines = typeof plan.oldText === 'string' ? privateKeyBodyLines(plan.oldText) : new Set();
  const newLines = typeof plan.newText === 'string' ? privateKeyBodyLines(plan.newText) : new Set();
  for (const hunk of plan.hunks) {
    if (shown >= PREVIEW_LIMITS.rows || budget.chars <= 0) break;
    const rows = [];
    for (const row of hideKeyBodies(hunk, oldLines, newLines)) {
      if (shown + rows.length >= PREVIEW_LIMITS.rows || budget.chars <= 0) break;
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
  const keys = plans.some((plan) => [plan.oldText, plan.newText].some((text) => typeof text === 'string' && privateKeyBodyLines(text).size > 0));
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
