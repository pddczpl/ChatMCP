// An approval request of the Hub, asked of the editor (plan task ux-20): what `session/request_permission` carries, and what the answer of the editor means.
//
// The Hub asks the person (its dashboard) before a call that changes files runs, in Review mode, and shows the change it WORKED OUT from the files as they are at that moment (docs/APPROVAL-PREVIEW.md:
// `detail.preview`). The editor is asked with the same change, as a diff, so that the person who answers in the editor sees what the person who answers in the dashboard sees. Nothing is invented:
// what the Hub left out (rows, files, private key material) is said to be left out, and a call the Hub would refuse is said to be one.
//
// The answer is read strictly. One option allows; a rejection, a cancellation, an option nobody offered and anything that cannot be read refuse.
import path from 'node:path';
import { kindOf, locationsOf, titleOf } from './event-map.mjs';

export const MAX_DIFF_FILES = 20;
const MAX_SIDE_CHARS = 200_000;
export const PERMISSION_OPTIONS = Object.freeze([
  Object.freeze({ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }),
  Object.freeze({ optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }),
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);
const note = (words) => ({ type: 'content', content: { type: 'text', text: words } });
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const bounded = (value) => (value.length <= MAX_SIDE_CHARS ? value : `${value.slice(0, MAX_SIDE_CHARS)}…`);

/** The public input of the call, from what the Hub says about the request: a path, several paths, a source and a destination, a command. */
function inputOf(detail, files) {
  const input = {};
  const first = text(detail.path);
  if (first) input.path = first;
  else if (files.length === 1 && text(files[0].path)) input.path = files[0].path;
  if (files.length > 1) input.paths = files.map((entry) => entry.path).filter((value) => text(value) !== null).slice(0, MAX_DIFF_FILES);
  if (text(detail.source)) input.source = detail.source;
  if (text(detail.destination)) input.destination = detail.destination;
  if (text(detail.command)) input.command = detail.command;
  return input;
}

/** The two texts of a file's hunks: the lines before (context and removed) and the lines after (context and added), the hunks apart by a line of dots, which both sides have. */
function textsOf(entry) {
  const hunks = Array.isArray(entry.hunks) ? entry.hunks : [];
  let before = '';
  let after = '';
  let any = false;
  for (const hunk of hunks) {
    if (!isObject(hunk) || !Array.isArray(hunk.rows)) continue;
    let oldSide = '';
    let newSide = '';
    for (const row of hunk.rows) {
      if (!isObject(row) || typeof row.text !== 'string') continue;
      const line = Number.isFinite(row.omitted) && row.omitted > 0 ? `${row.text}…` : row.text;
      if (row.kind === 'context') { oldSide += line; newSide += line; } else if (row.kind === 'removed') oldSide += line;
      else if (row.kind === 'added') newSide += line;
    }
    if (oldSide === '' && newSide === '') continue;
    if (any) { before += '…\n'; after += '…\n'; }
    before += oldSide;
    after += newSide;
    any = true;
  }
  return any ? { before: bounded(before), after: bounded(after) } : null;
}

const absoluteInside = (cwd, value) => {
  if (typeof cwd !== 'string' || cwd === '') return value;
  const absolute = path.resolve(cwd, value);
  const relative = path.relative(cwd, absolute);
  return relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? value : absolute;
};

function contentOf(request, detail, cwd) {
  const preview = isObject(detail.preview) ? detail.preview : null;
  if (preview === null) {
    const words = text(request.summary) ?? text(request.reason);
    return words ? [note(words)] : [];
  }
  const content = [];
  const files = Array.isArray(preview.files) ? preview.files.filter((entry) => isObject(entry) && text(entry.path) !== null) : [];
  let hiddenRows = 0;
  let invisible = false;
  let keyRows = 0;
  for (const entry of files.slice(0, MAX_DIFF_FILES)) {
    const sides = textsOf(entry);
    if (sides !== null) content.push({ type: 'diff', path: absoluteInside(cwd, entry.path), oldText: entry.action === 'create' ? null : sides.before, newText: sides.after });
    if (entry.oldUnreadable === true) content.push(note(`${entry.path}: the existing file is not text, so what it holds now is not shown.`));
    if (Number.isFinite(entry.hiddenRows) && entry.hiddenRows > 0) hiddenRows += entry.hiddenRows;
    if (Number.isFinite(entry.hiddenKeyRows) && entry.hiddenKeyRows > 0) keyRows += entry.hiddenKeyRows;
    if (Array.isArray(entry.hunks) && entry.hunks.some((hunk) => isObject(hunk) && hunk.invisibleOnly === true)) invisible = true;
  }
  if (isObject(preview.error)) content.push(note(`This call would be refused when it runs: ${text(preview.error.message) ?? text(preview.error.code) ?? 'the Hub gave no reason'}`));
  if (hiddenRows > 0) content.push(note(`${plural(hiddenRows, 'more row is', 'more rows are')} not shown.`));
  if (invisible) content.push(note('Only the line endings (or the byte order mark) of a file change; the lines look the same.'));
  if (preview.privateKeys === true || keyRows > 0) content.push(note('This call touches private key material: what the model wrote of it is not shown.'));
  const left = Math.max(0, files.length - MAX_DIFF_FILES) + (Number.isFinite(preview.hiddenFiles) && preview.hiddenFiles > 0 ? preview.hiddenFiles : 0);
  if (left > 0) content.push(note(`${plural(left, 'more file is', 'more files are')} not shown.`));
  return content;
}

/**
 * The parameters of `session/request_permission` for a request the Hub holds.
 * @param {{sessionId: string, request: object, callId?: string, cwd: string}} input
 *   `callId`: the id of the call as the editor was told (the call that waits); without it the id of the request names the call.
 */
export function permissionRequestFor({ sessionId, request, callId, cwd }) {
  const asked = isObject(request) ? request : {};
  const detail = isObject(asked.detail) ? asked.detail : {};
  const files = isObject(detail.preview) && Array.isArray(detail.preview.files) ? detail.preview.files.filter((entry) => isObject(entry)) : [];
  const input = inputOf(detail, files);
  const locations = locationsOf(input, cwd);
  const content = contentOf(asked, detail, cwd);
  return {
    sessionId,
    toolCall: {
      toolCallId: typeof callId === 'string' && callId !== '' ? callId : `approval-${String(asked.id ?? 'unknown')}`,
      title: titleOf(asked.toolName, input),
      kind: kindOf(asked.toolName),
      status: 'pending',
      ...(locations.length ? { locations } : {}),
      ...(Object.keys(input).length ? { rawInput: input } : {}),
      ...(content.length ? { content } : {}),
    },
    options: PERMISSION_OPTIONS.map((option) => ({ ...option })),
  };
}

export const MIN_ANSWER_MS = 1000;
export const MAX_ANSWER_MS = 15 * 60 * 1000; // the Hub lets an approval request wait 10 minutes; the question to the editor does not outlive it by much

/**
 * How long the editor is given to answer: until the Hub drops the request (its `expiresAt`), but never less than a second (a request that is about to expire is still put to the person) and never more
 * than fifteen minutes; a request that says nothing usable gets the longest.
 */
export function answerWindowMs(request, now = Date.now()) {
  const left = (isObject(request) && typeof request.expiresAt === 'string' ? Date.parse(request.expiresAt) : Number.NaN) - now;
  return Number.isFinite(left) ? Math.min(Math.max(left, MIN_ANSWER_MS), MAX_ANSWER_MS) : MAX_ANSWER_MS;
}

/** What the answer of the editor means: `{approved, why}`. Only the option `allow_once` of a selected outcome allows. */
export function decisionFrom(response) {
  const outcome = isObject(response) && isObject(response.outcome) ? response.outcome : null;
  if (outcome === null) return { approved: false, why: 'unreadable' };
  if (outcome.outcome === 'cancelled') return { approved: false, why: 'cancelled' };
  if (outcome.outcome === 'selected' && outcome.optionId === 'allow_once') return { approved: true, why: 'allowed' };
  if (outcome.outcome === 'selected' && outcome.optionId === 'reject_once') return { approved: false, why: 'rejected' };
  return { approved: false, why: 'unreadable' };
}
