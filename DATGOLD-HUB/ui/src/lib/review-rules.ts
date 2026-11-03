// What the Review tab may offer for a file, given what the Hub says about the file and about the moment: the rules, without a page. A rule that the Hub enforces is mirrored here so that
// the tab does not offer what will be refused, and says why; the Hub still decides. Nothing here throws, and nothing here has a word in it: a note is a code that the tab turns into text.
import { pendingHunks } from './review-hunks.ts';
import type { DiffRow, FileDiff } from './review-hunks.ts';
import type { ReviewFile } from './review-source.ts';

/** A hunk shows this many rows before it asks to show more. */
export const ROW_LIMIT = 200;

/**
 * Whether the Hub will write to the workspace now. It refuses a save and moving a new file away while ANY task runs (not only the one on screen), and under sandbox-only it refuses to write,
 * to record an acceptance and to move a file at all.
 */
export type WriteState = 'ok' | 'running' | 'policy';

export function writeState(context?: { activeTaskId?: string | null; executionPolicy?: string | null } | null): WriteState {
  if (context?.executionPolicy === 'sandbox-only') return 'policy';
  return context?.activeTaskId ? 'running' : 'ok';
}

/** How a file is reviewed: as text, as a new file, as a deleted one, as a binary file, or not at all (the Hub sent no text for it). */
export type FileMode = 'text' | 'created' | 'deleted' | 'binary' | 'unavailable';

export function fileMode(file: ReviewFile): FileMode {
  if (file.status === 'binary') return 'binary';
  if (file.textUnavailable) return 'unavailable';
  const has = (text: string | null | undefined) => typeof text === 'string';
  if (file.change === 'created') return has(file.currentText) ? 'created' : 'unavailable';
  if (file.change === 'deleted') return has(file.baselineText) ? 'deleted' : 'unavailable';
  return has(file.baselineText) && has(file.currentText) ? 'text' : 'unavailable';
}

/** Why something is off or limited; the tab asks for it as t(`review_note_${note}`). */
export type FileNote = 'running' | 'policy' | 'deleted' | 'binary' | 'not_utf8' | 'too_large' | 'checkpoint_corrupt' | 'budget' | 'baseline_unavailable' | 'no_text' | 'not_rejectable';

export interface FileActions {
  mode: FileMode;
  /** The hunks of the file are shown, and can be accepted and put back one by one. */
  byHunk: boolean;
  acceptHunk: boolean;
  rejectHunk: boolean;
  acceptFile: boolean;
  rejectFile: boolean;
  note: FileNote | null;
}

export function fileActions(file: ReviewFile, state: WriteState): FileActions {
  const mode = fileMode(file);
  // The Hub ties an acceptance to a checkpoint and to the sha that was reviewed; without either there is nothing to record.
  const canRecord = state !== 'policy' && Boolean(file.currentSha) && Boolean(file.checkpointId);
  const canWrite = state === 'ok';
  const moment: FileNote | null = state === 'ok' ? null : state;
  if (mode === 'text') return { mode, byHunk: true, acceptHunk: true, rejectHunk: canWrite, acceptFile: canRecord, rejectFile: canWrite, note: moment };
  if (mode === 'created') {
    // A new file is moved away as a whole (the Hub keeps it in its undo folder); its lines are not undone one by one.
    return { mode, byHunk: false, acceptHunk: false, rejectHunk: false, acceptFile: canRecord, rejectFile: canWrite && file.rejectable === true, note: moment ?? (file.rejectable === true ? null : 'not_rejectable') };
  }
  // The save of the Hub only overwrites a file that is there: a deleted file can be read, not brought back from here.
  if (mode === 'deleted') return { mode, byHunk: false, acceptHunk: false, rejectHunk: false, acceptFile: false, rejectFile: false, note: 'deleted' };
  const reason = file.textUnavailable;
  const note: FileNote = mode === 'binary' ? (reason === 'not_utf8' ? 'not_utf8' : 'binary') : (reason && reason !== 'binary' && reason !== 'not_utf8' ? reason : 'no_text');
  return { mode, byHunk: false, acceptHunk: false, rejectHunk: false, acceptFile: canRecord, rejectFile: false, note };
}

/** What happened to a write, by the status and code the Hub gave (api.request keeps both on the error). */
export type ConflictKind = 'stale' | 'busy' | 'policy' | 'locked' | 'too_large' | 'unsupported' | 'other';

const STALE_CODES = new Set(['stale_revision', 'stale_review', 'bad_revision', 'revision_required']);

export function conflictKind(error: unknown): ConflictKind {
  const { status, code } = (error && typeof error === 'object' ? error : {}) as { status?: unknown; code?: unknown };
  // A save during a run is a 409 with no code; the refusal of sandbox-only is a 403 with no code (a 403 with a code, such as file_type, is something else).
  if (status === 403) return code === undefined ? 'policy' : 'other';
  if (status === 409) {
    if (typeof code === 'string' && STALE_CODES.has(code)) return 'stale';
    return code === undefined || code === 'task_in_progress' ? 'busy' : 'other';
  }
  if (status === 423) return 'locked';
  if (status === 413) return 'too_large';
  if (status === 415) return 'unsupported';
  return 'other';
}

export type KeyAction = 'next' | 'prev' | 'accept' | 'reject';

const KEYS: Record<string, KeyAction> = { j: 'next', k: 'prev', a: 'accept', r: 'reject' };

/** The single keys of the tab. A key with Ctrl, Alt or Meta is the browser's (Ctrl+R reloads the page), never the tab's. */
export function keyAction(event: { key?: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): KeyAction | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  return typeof event.key === 'string' && Object.hasOwn(KEYS, event.key) ? KEYS[event.key] : null;
}

/** The hunk after moving by `delta` from `current` (-1: none yet). It stops at the first and at the last; -1 when there is no hunk. */
export function moveHunk(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta < 0 ? count - 1 : 0;
  return Math.min(count - 1, Math.max(0, current + delta));
}

/** The first `shown` rows of a hunk and how many are still hidden ("N more lines"). */
export function visibleRows(rows: readonly DiffRow[], shown: number = ROW_LIMIT): { rows: DiffRow[]; hidden: number } {
  const limit = Number.isNaN(shown) ? ROW_LIMIT : Math.max(0, Math.floor(shown));
  return { rows: rows.slice(0, limit), hidden: Math.max(0, rows.length - limit) };
}

export type Terminator = 'crlf' | 'lf' | 'none';

/** How a line ends. A lone carriage return is part of the line (as Git has it), so it is not an ending. */
export function terminatorOf(text: string): Terminator {
  if (text.endsWith('\r\n')) return 'crlf';
  return text.endsWith('\n') ? 'lf' : 'none';
}

/** The line as it is shown: without the characters that end it. */
export function lineBody(text: string): string {
  return text.slice(0, text.length - (terminatorOf(text) === 'crlf' ? 2 : terminatorOf(text) === 'lf' ? 1 : 0));
}

export interface FileSummary { hunks: number; pending: number; added: number; removed: number }

/** A file for the list: its hunks, how many are still to be reviewed, and the lines added and taken away. */
export function summarizeFile(file: ReviewFile, diff: FileDiff | null, accepted: ReadonlySet<string>): FileSummary {
  const mode = fileMode(file);
  if (!diff || mode === 'binary' || mode === 'unavailable') return { hunks: 0, pending: 0, added: 0, removed: 0 };
  return {
    hunks: diff.hunks.length,
    pending: pendingHunks(diff.hunks, accepted).length,
    added: diff.hunks.reduce((total, hunk) => total + hunk.added, 0),
    removed: diff.hunks.reduce((total, hunk) => total + hunk.removed, 0),
  };
}

/** One file of the review with its diff (none for a file with no text) and the hunks accepted on it. */
export interface ReviewItem { file: ReviewFile; diff: FileDiff | null; accepted: ReadonlySet<string> }

/** The hunks still to be reviewed, in the files that are reviewed hunk by hunk: a new or a deleted file is one block, not a list of hunks to go through. */
export function pendingTotal(items: readonly ReviewItem[]): number {
  return items.reduce((total, { file, diff, accepted }) => total + (fileMode(file) === 'text' ? summarizeFile(file, diff, accepted).pending : 0), 0);
}

export interface RejectPlan {
  /** Text files that would be saved with their baseline text. */
  rewrite: number;
  /** The hunks in those files. */
  hunks: number;
  /** New files that would be moved to the undo folder. */
  created: number;
  /** Files that stay as they are: deleted, binary, without text, a new file the Hub cannot move, a text file with nothing to put back, or every file when writing is not allowed. */
  left: number;
}

/** What "put everything back" would do, so that the dialog can say it before it is done. */
export function planReject(items: readonly ReviewItem[], state: WriteState): RejectPlan {
  const plan: RejectPlan = { rewrite: 0, hunks: 0, created: 0, left: 0 };
  for (const { file, diff } of items) {
    const actions = fileActions(file, state);
    if (actions.rejectFile && actions.mode === 'text' && diff && diff.hunks.length > 0) {
      plan.rewrite += 1;
      plan.hunks += diff.hunks.length;
    } else if (actions.rejectFile && actions.mode === 'created') plan.created += 1;
    else plan.left += 1;
  }
  return plan;
}

export interface AcceptPlan {
  /** Files the Hub would record as accepted (not recorded yet, and with a sha and a checkpoint to tie it to). */
  files: number;
  /** Hunks that would be marked accepted on the page. */
  hunks: number;
}

/** What "accept everything" would do. Accepting writes nothing, so it goes on while a task runs; under sandbox-only the Hub records nothing, but the marks are the page's. */
export function planAccept(items: readonly ReviewItem[], state: WriteState): AcceptPlan {
  const plan: AcceptPlan = { files: 0, hunks: 0 };
  for (const { file, diff, accepted } of items) {
    const actions = fileActions(file, state);
    if (actions.acceptFile && !file.accepted) plan.files += 1;
    if (actions.byHunk && actions.acceptHunk && diff) plan.hunks += pendingHunks(diff.hunks, accepted).length;
  }
  return plan;
}
